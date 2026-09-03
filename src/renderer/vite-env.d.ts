/// <reference types="vite/client" />
import type { CockpitApi } from "../shared/contracts.js";

declare global {
  interface Window {
    readonly cockpitApi?: CockpitApi;
  }
}
