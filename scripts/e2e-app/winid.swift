// Só leitura: a MAIOR janela (camada 0) de um processo → número dela pro `screencapture -l`.
import CoreGraphics
import Foundation
let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
var best = 0, area = 0.0
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid && (w[kCGWindowLayer as String] as? Int) == 0 {
  if let n = w[kCGWindowNumber as String] as? Int, let b = w[kCGWindowBounds as String] as? [String: Any], let h = b["Height"] as? Double, let wd = b["Width"] as? Double, h * wd > area { area = h * wd; best = n }
}
if best > 0 { print(best) }
