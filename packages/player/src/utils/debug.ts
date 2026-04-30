import type { Store } from "jotai/vanilla/store";
import { enableDebugModeAtom } from "../states/appAtoms.ts";

export const debugLog = (store: Store, ...data: unknown[]) => {
	if (store.get(enableDebugModeAtom)) {
		console.log(...data);
	}
};

export const debugWarn = (store: Store, ...data: unknown[]) => {
	if (store.get(enableDebugModeAtom)) {
		console.warn(...data);
	}
};
