/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_CROSSFLOW_API?: string;
  readonly VITE_CROSSFLOW_RPC?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
