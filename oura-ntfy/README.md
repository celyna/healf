# healf app

See the [repository README](../README.md) for the purpose, architecture, setup, privacy model and operation.

Run app commands from this directory:

```sh
npm test
npm run setup
npm start
# or deploy with Docker:
docker compose up -d --build
```

Node.js 24 or newer is required. Configuration belongs in `.env`; use `.env.example` as the template. Do not commit secrets or health data.
