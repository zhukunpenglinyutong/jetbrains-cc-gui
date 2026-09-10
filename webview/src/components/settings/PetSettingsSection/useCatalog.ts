import { useCallback, useEffect, useRef, useState } from 'react';
import {
  petBridge,
  type CatalogPageSize,
  type CatalogSort,
  type PetdexCatalogPet,
} from '../../codexPet/petBridge';
import { normalizeCatalogQuery, petErrorDescriptor } from './utils';

export interface CatalogState {
  catalog: PetdexCatalogPet[];
  catalogTotal: number;
  catalogLoading: boolean;
  catalogError: string | null;
  search: string;
  setSearch: (value: string) => void;
  currentPage: number;
  pageInput: string;
  setPageInput: (value: string) => void;
  totalPages: number;
  catalogErrorDescriptor: { key: string; params?: Record<string, string> } | null;
  requestCatalog: (
    forceRefresh: boolean,
    query: string,
    offset: number,
    limit: CatalogPageSize,
    sort: CatalogSort,
  ) => void;
  reloadAfterOperation: (forceRefresh: boolean) => void;
  refreshCatalog: () => void;
  goToPage: (page: number) => void;
  commitPageInput: () => void;
}

export function useCatalog(catalogPageSize: CatalogPageSize, catalogSort: CatalogSort): CatalogState {
  const [catalog, setCatalog] = useState<PetdexCatalogPet[]>([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageInput, setPageInput] = useState('1');
  const searchRef = useRef('');
  const currentPageRef = useRef(1);
  const catalogPageSizeRef = useRef(catalogPageSize);
  const catalogSortRef = useRef(catalogSort);
  const catalogRequestIdRef = useRef(0);

  const requestCatalog = useCallback((
    forceRefresh: boolean,
    query: string,
    offset: number,
    limit: CatalogPageSize,
    sort: CatalogSort,
  ) => {
    const normalizedQuery = normalizeCatalogQuery(query);
    const requestId = ++catalogRequestIdRef.current;
    petBridge.getCatalog(forceRefresh, normalizedQuery, offset, limit, sort, requestId);
  }, []);

  useEffect(() => {
    searchRef.current = normalizeCatalogQuery(search);
  }, [search]);

  useEffect(() => {
    catalogPageSizeRef.current = catalogPageSize;
    catalogSortRef.current = catalogSort;
  }, [catalogPageSize, catalogSort]);

  useEffect(() => {
    const unsubscribeAssets = petBridge.subscribeAssetChanges(() => {
      petBridge.getConfig();
      petBridge.getLocalPets();
      setCatalogLoading(true);
      setCatalogError(null);
      requestCatalog(
        false,
        searchRef.current,
        (currentPageRef.current - 1) * catalogPageSizeRef.current,
        catalogPageSizeRef.current,
        catalogSortRef.current,
      );
    });
    const unsubscribeCatalog = petBridge.subscribeCatalog((payload) => {
      if (payload.requestId !== undefined && payload.requestId !== catalogRequestIdRef.current) return;
      if (payload.query !== searchRef.current) return;
      if (payload.limit !== catalogPageSizeRef.current) return;
      if (payload.sort !== catalogSortRef.current) return;
      const responsePage = Math.floor(payload.offset / catalogPageSizeRef.current) + 1;
      setCatalog(payload.pets);
      setCurrentPage(responsePage);
      setPageInput(String(responsePage));
      currentPageRef.current = responsePage;
      setCatalogTotal(payload.total);
      setCatalogError(payload.error ?? null);
      setCatalogLoading(false);
    });
    return () => {
      unsubscribeAssets();
      unsubscribeCatalog();
    };
  }, [requestCatalog]);

  useEffect(() => {
    setCurrentPage(1);
    setPageInput('1');
    currentPageRef.current = 1;
    setCatalog([]);
    setCatalogLoading(true);
    setCatalogError(null);
    const timer = window.setTimeout(() => {
      requestCatalog(false, search, 0, catalogPageSize, catalogSort);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [requestCatalog, search, catalogPageSize, catalogSort]);

  const refreshCatalog = useCallback(() => {
    setCatalogLoading(true);
    setCatalogError(null);
    requestCatalog(
      true,
      search,
      (currentPageRef.current - 1) * catalogPageSize,
      catalogPageSize,
      catalogSort,
    );
  }, [requestCatalog, search, catalogPageSize, catalogSort]);
  const reloadAfterOperation = useCallback((forceRefresh: boolean) => {
    setCatalogLoading(true);
    requestCatalog(
      forceRefresh,
      searchRef.current,
      (currentPageRef.current - 1) * catalogPageSizeRef.current,
      catalogPageSizeRef.current,
      catalogSortRef.current,
    );
  }, [requestCatalog]);

  const totalPages = Math.max(1, Math.ceil(catalogTotal / catalogPageSize));
  const catalogErrorDescriptor = catalogError ? petErrorDescriptor(catalogError) : null;
  const goToPage = useCallback((page: number) => {
    const nextPage = Math.max(1, Math.min(page, totalPages));
    currentPageRef.current = nextPage;
    setPageInput(String(nextPage));
    setCatalogLoading(true);
    setCatalogError(null);
    requestCatalog(
      false,
      search,
      (nextPage - 1) * catalogPageSize,
      catalogPageSize,
      catalogSort,
    );
  }, [requestCatalog, search, totalPages, catalogPageSize, catalogSort]);

  const commitPageInput = useCallback(() => {
    const parsedPage = Number.parseInt(pageInput, 10);
    if (!Number.isFinite(parsedPage)) {
      setPageInput(String(currentPage));
      return;
    }
    goToPage(parsedPage);
  }, [currentPage, goToPage, pageInput]);

  return {
    catalog,
    catalogTotal,
    catalogLoading,
    catalogError,
    search,
    setSearch,
    currentPage,
    pageInput,
    setPageInput,
    totalPages,
    catalogErrorDescriptor,
    requestCatalog,
    reloadAfterOperation,
    refreshCatalog,
    goToPage,
    commitPageInput,
  };
}
