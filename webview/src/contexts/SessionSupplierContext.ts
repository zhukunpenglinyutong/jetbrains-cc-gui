import { createContext, useContext } from 'react';
import type { SessionSupplierState } from '../hooks/useSessionSuppliers';

/** One controller per chat, shared with the existing input settings menu. */
export const SessionSupplierContext = createContext<SessionSupplierState | null>(null);

export const useSessionSupplier = () => useContext(SessionSupplierContext);
