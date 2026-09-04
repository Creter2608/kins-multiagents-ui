/// <reference types="vite/client" />
import type { CockpitApi } from "../shared/contracts.js";

declare global {
  const __APP_VERSION__: string;
  interface Window {
    readonly cockpitApi?: CockpitApi;
  }
}
