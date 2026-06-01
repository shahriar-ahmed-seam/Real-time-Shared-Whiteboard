# Local demo launcher: sets env (no dotenv in the app) and runs the compiled server.
$env:NODE_ENV = "development"
$env:PORT = "3001"
$env:CLIENT_ORIGINS = "http://localhost:5173,http://localhost:5174"
$env:DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:5433/synapse"
$env:REDIS_URL = "redis://127.0.0.1:6380"
$env:JWT_SECRET = "local-demo-secret-please-change-me-32chars"
$env:OPEN_MODE = "true"
$env:LOG_LEVEL = "info"
node dist/index.js
