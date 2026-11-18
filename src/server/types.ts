import type { CommerceStore } from "../data/store";

export type AppEnv = {
  Variables: {
    traceId: string;
    store: CommerceStore;
    customerId: string | null;
    staffId: string | null;
  };
};
