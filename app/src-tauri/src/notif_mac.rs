//! Notificações nativas do macOS via UNUserNotificationCenter.
//!
//! Por que não a NSUserNotification (mac-notification-sys): é a API antiga,
//! presa ao registro que o macOS guardou do app. Depois do rename
//! Constellation → Starfork o registro em com.apple.ncprefs ficou apontando pra
//! /Applications/Constellation.app (que não existe mais) e as notificações
//! pararam de aparecer, sem erro nenhum. A UN pede autorização pelo bundle ATUAL
//! (isso re-registra o app com o caminho certo e mostra o pedido de permissão
//! quando preciso), aparece em Ajustes do Sistema › Notificações › Starfork e
//! entrega o clique pelo delegate.
//!
//! A UN só existe pra app EMPACOTADO (.app com bundle id). Rodando o binário
//! solto (cargo run / tauri dev) `currentNotificationCenter` lança exceção ObjC
//! — por isso `available()` checa o bundle antes e tudo passa por
//! `objc2::exception::catch`. Fora do bundle o front cai no tauri-plugin.

use std::sync::{Mutex, OnceLock};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject};
use objc2::{define_class, msg_send, AllocAnyThread};
use objc2_foundation::{NSBundle, NSDictionary, NSError, NSString, NSUUID};
use objc2_user_notifications::{
    UNAuthorizationOptions, UNAuthorizationStatus, UNMutableNotificationContent, UNNotification,
    UNNotificationPresentationOptions, UNNotificationRequest, UNNotificationResponse,
    UNNotificationSettings, UNNotificationSound, UNUserNotificationCenter,
    UNUserNotificationCenterDelegate,
};

/// Handle do app pro delegate (o clique chega numa fila do sistema, fora do Tauri).
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

/// Chave do id da tarefa no userInfo da notificação (lida de volta no clique).
const TASK_KEY: &str = "taskId";

/// A UN só funciona num .app com bundle id. Fora disso (dev) não chamamos nada.
pub fn available() -> bool {
    static OK: OnceLock<bool> = OnceLock::new();
    *OK.get_or_init(|| {
        let b = NSBundle::mainBundle();
        let is_app = b.bundlePath().to_string().ends_with(".app");
        is_app && b.bundleIdentifier().is_some()
    })
}

/// Centro de notificações do processo, sem deixar exceção ObjC derrubar o app.
fn center() -> Option<Retained<UNUserNotificationCenter>> {
    if !available() {
        return None;
    }
    objc2::exception::catch(UNUserNotificationCenter::currentNotificationCenter).ok()
}

define_class!(
    // SAFETY: NSObject não tem requisitos de subclasse; sem Drop; ivars vazios.
    #[unsafe(super(NSObject))]
    #[name = "StarforkNotifDelegate"]
    struct NotifDelegate;

    unsafe impl NSObjectProtocol for NotifDelegate {}

    unsafe impl UNUserNotificationCenterDelegate for NotifDelegate {
        /// App em primeiro plano: o macOS por padrão ESCONDE a notificação.
        /// Mostramos mesmo assim (banner + som + central).
        #[unsafe(method(userNotificationCenter:willPresentNotification:withCompletionHandler:))]
        fn will_present(
            &self,
            _center: &UNUserNotificationCenter,
            _notification: &UNNotification,
            handler: &block2::DynBlock<dyn Fn(UNNotificationPresentationOptions)>,
        ) {
            handler.call((UNNotificationPresentationOptions::Banner
                | UNNotificationPresentationOptions::Sound
                | UNNotificationPresentationOptions::List,));
        }

        /// Clique na notificação → traz a janela e manda o front abrir a tarefa.
        #[unsafe(method(userNotificationCenter:didReceiveNotificationResponse:withCompletionHandler:))]
        fn did_receive(
            &self,
            _center: &UNUserNotificationCenter,
            response: &UNNotificationResponse,
            handler: &block2::DynBlock<dyn Fn()>,
        ) {
            let task_id = task_id_of(response);
            if let Some(app) = APP.get() {
                use tauri::{Emitter, Manager};
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.unminimize();
                    let _ = w.set_focus();
                }
                let _ = app.emit("notif-open", task_id);
            }
            handler.call(());
        }
    }
);

impl NotifDelegate {
    fn new() -> Retained<Self> {
        let this = Self::alloc().set_ivars(());
        // SAFETY: init padrão do NSObject.
        unsafe { msg_send![super(this), init] }
    }
}

fn task_id_of(response: &UNNotificationResponse) -> String {
    let info = response.notification().request().content().userInfo();
    let key = NSString::from_str(TASK_KEY);
    // SAFETY: a chave é NSString (NSCopying); o valor é checado por downcast.
    let v: Option<Retained<AnyObject>> = unsafe { msg_send![&*info, objectForKey: &*key] };
    v.and_then(|o| o.downcast::<NSString>().ok()).map(|s| s.to_string()).unwrap_or_default()
}

/// Chamar UMA vez no setup do Tauri (thread principal): instala o delegate
/// (antes de qualquer clique ser entregue — inclusive o que abriu o app) e pede
/// autorização. O pedido é o que faz o macOS (re)registrar o app no caminho
/// atual e mostrar "Starfork gostaria de enviar notificações" se ainda não decidido.
pub fn init(app: tauri::AppHandle) {
    let _ = APP.set(app);
    let Some(c) = center() else {
        crate::web_log("[notif] UNUserNotificationCenter indisponível (fora do .app) — usando o plugin".into());
        return;
    };
    let d = NotifDelegate::new();
    c.setDelegate(Some(ProtocolObject::from_ref(&*d)));
    // o delegate é referência FRACA no centro: segura pra vida inteira do app
    std::mem::forget(d);
    let opts = UNAuthorizationOptions::Alert | UNAuthorizationOptions::Sound | UNAuthorizationOptions::Badge;
    let done = RcBlock::new(|granted: Bool, err: *mut NSError| {
        // SAFETY: ponteiro nulo ou NSError válido durante o bloco.
        let e = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string());
        crate::web_log(format!("[notif] autorização: granted={} err={:?}", granted.as_bool(), e));
    });
    c.requestAuthorizationWithOptions_completionHandler(opts, &done);
}

/// Espera a resposta de um completion handler sem prender thread do runtime.
async fn wait<T: Send + 'static>(rx: tokio::sync::oneshot::Receiver<T>, what: &str) -> Result<T, String> {
    match tokio::time::timeout(std::time::Duration::from_secs(8), rx).await {
        Ok(Ok(v)) => Ok(v),
        _ => Err(format!("o macOS não respondeu ao {what}")),
    }
}

fn once_sender<T>(tx: tokio::sync::oneshot::Sender<T>) -> Mutex<Option<tokio::sync::oneshot::Sender<T>>> {
    Mutex::new(Some(tx))
}

/// Posta a notificação. Erro (não autorizado, fora do .app…) volta pro front,
/// que cai no tauri-plugin.
pub async fn post(title: String, body: String, task_id: Option<String>) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    {
        // bloco síncrono: nada de objeto ObjC atravessa o await
        let c = center().ok_or("notificações nativas indisponíveis fora do app instalado")?;
        let content = UNMutableNotificationContent::new();
        content.setTitle(&NSString::from_str(&title));
        content.setBody(&NSString::from_str(&body));
        content.setSound(Some(&UNNotificationSound::defaultSound()));
        let key = NSString::from_str(TASK_KEY);
        let val = NSString::from_str(task_id.as_deref().unwrap_or(""));
        let info = NSDictionary::<NSString, NSString>::from_slices(&[&*key], &[&*val]);
        // SAFETY: userInfo precisa ser plist-serializável — NSString→NSString é.
        unsafe {
            let info: &NSDictionary = &*(Retained::as_ptr(&info) as *const NSDictionary);
            content.setUserInfo(info);
        }
        let id = NSUUID::new().UUIDString();
        let req = UNNotificationRequest::requestWithIdentifier_content_trigger(&id, &content, None);
        let tx = once_sender(tx);
        let done = RcBlock::new(move |err: *mut NSError| {
            // SAFETY: ponteiro nulo ou NSError válido durante o bloco.
            let e = unsafe { err.as_ref() }.map(|e| e.localizedDescription().to_string());
            if let Some(tx) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = tx.send(e);
            }
        });
        c.addNotificationRequest_withCompletionHandler(&req, Some(&done));
    }
    match wait(rx, "envio da notificação").await? {
        None => Ok(()),
        Some(e) => {
            crate::web_log(format!("[notif] envio falhou: {e}"));
            Err(e)
        }
    }
}

/// Estado da permissão: authorized · denied · notDetermined · provisional ·
/// unsupported (fora do .app).
pub async fn status() -> Result<String, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<String>();
    {
        let Some(c) = center() else { return Ok("unsupported".into()) };
        let tx = once_sender(tx);
        let done = RcBlock::new(move |s: std::ptr::NonNull<UNNotificationSettings>| {
            // SAFETY: o sistema passa um UNNotificationSettings válido durante o bloco.
            let st = unsafe { s.as_ref() }.authorizationStatus();
            let name = match st {
                UNAuthorizationStatus::Authorized | UNAuthorizationStatus::Ephemeral => "authorized",
                UNAuthorizationStatus::Denied => "denied",
                UNAuthorizationStatus::Provisional => "provisional",
                _ => "notDetermined",
            };
            if let Some(tx) = tx.lock().ok().and_then(|mut g| g.take()) {
                let _ = tx.send(name.to_string());
            }
        });
        c.getNotificationSettingsWithCompletionHandler(&done);
    }
    wait(rx, "pedido de status das notificações").await
}

