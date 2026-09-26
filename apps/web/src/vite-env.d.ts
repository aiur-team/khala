/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly PUBLIC_APP_ORIGIN?: string;
  readonly PUBLIC_HOMESERVER_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
