import type { RcApi } from '../../shared/api';

declare global {
  interface Window {
    rc: RcApi;
  }
}

export const rc: RcApi = window.rc;
