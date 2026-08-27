# Exemplo de configuração

Abaixo está um exemplo de arquivo de configuração no formato **YAML**.

```yaml
# config.yaml — exemplo de configuração
app:
  name: cardume
  version: 1.0.0
  environment: production   # development | staging | production

server:
  host: 0.0.0.0
  port: 8080
  timeout_seconds: 30

database:
  driver: postgres
  host: localhost
  port: 5432
  name: cardume_db
  user: cardume
  password: ${DB_PASSWORD}   # use variável de ambiente para segredos
  pool:
    min: 2
    max: 10

logging:
  level: info                # debug | info | warn | error
  format: json               # text | json
  output: stdout

features:
  - metrics
  - tracing
  - health-check
```

## Notas

- Indentação em YAML usa **espaços** (nunca tabs).
- Segredos como senhas devem vir de variáveis de ambiente (ex.: `${DB_PASSWORD}`), não versionados.
- Comentários começam com `#`.
