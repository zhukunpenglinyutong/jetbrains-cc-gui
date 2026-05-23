import { useCallback, useEffect, useRef, useState } from 'react';
import type { TFunction } from 'i18next';
import type { PermissionRequest } from '../components/PermissionDialog';
import type { AskUserQuestionRequest } from '../components/AskUserQuestionDialog';
import type { PlanApprovalRequest } from '../components/PlanApprovalDialog';
import type { RewindRequest } from '../components/RewindDialog';
import type { ContextUsageData } from '../components/ContextUsageDialog';
import { sendBridgeEvent } from '../utils/bridge';

interface UseDialogManagementOptions {
  t: TFunction;
}

interface UseDialogManagementReturn {
  // Permission dialog
  permissionDialogOpen: boolean;
  currentPermissionRequest: PermissionRequest | null;
  openPermissionDialog: (request: PermissionRequest) => void;
  handlePermissionApprove: (channelId: string) => void;
  handlePermissionApproveAlways: (channelId: string) => void;
  handlePermissionSkip: (channelId: string) => void;

  // AskUserQuestion dialog
  askUserQuestionDialogOpen: boolean;
  currentAskUserQuestionRequest: AskUserQuestionRequest | null;
  openAskUserQuestionDialog: (request: AskUserQuestionRequest) => void;
  handleAskUserQuestionSubmit: (requestId: string, answers: Record<string, string | string[]>) => void;
  handleAskUserQuestionCancel: (requestId: string) => void;

  // PlanApproval dialog
  planApprovalDialogOpen: boolean;
  currentPlanApprovalRequest: PlanApprovalRequest | null;
  openPlanApprovalDialog: (request: PlanApprovalRequest) => void;
  handlePlanApprovalApprove: (requestId: string, targetMode: string) => void;
  handlePlanApprovalReject: (requestId: string) => void;

  // Rewind dialog
  rewindDialogOpen: boolean;
  setRewindDialogOpen: (open: boolean) => void;
  currentRewindRequest: RewindRequest | null;
  setCurrentRewindRequest: (request: RewindRequest | null) => void;
  isRewinding: boolean;
  setIsRewinding: (loading: boolean) => void;

  // Rewind select dialog
  rewindSelectDialogOpen: boolean;
  setRewindSelectDialogOpen: (open: boolean) => void;

  // Context usage dialog
  contextUsageDialogOpen: boolean;
  contextUsageIsLoading: boolean;
  contextUsageData: ContextUsageData | null;
  openContextUsageDialog: (requestId?: string | null, loading?: boolean) => void;
  updateContextUsageData: (requestId: string | null | undefined, data: ContextUsageData) => boolean;
  closeContextUsageDialog: (requestId?: string | null) => boolean;
}

/**
 * Hook for managing dialog states (permission, ask user question, rewind)
 */
export function useDialogManagement({ t }: UseDialogManagementOptions): UseDialogManagementReturn {
  // Permission dialog state
  const [permissionDialogOpen, setPermissionDialogOpen] = useState(false);
  const [currentPermissionRequest, setCurrentPermissionRequest] = useState<PermissionRequest | null>(null);
  const permissionDialogOpenRef = useRef(false);
  const currentPermissionRequestRef = useRef<PermissionRequest | null>(null);
  const pendingPermissionRequestsRef = useRef<PermissionRequest[]>([]);

  // AskUserQuestion dialog state
  const [askUserQuestionDialogOpen, setAskUserQuestionDialogOpen] = useState(false);
  const [currentAskUserQuestionRequest, setCurrentAskUserQuestionRequest] = useState<AskUserQuestionRequest | null>(null);
  const askUserQuestionDialogOpenRef = useRef(false);
  const currentAskUserQuestionRequestRef = useRef<AskUserQuestionRequest | null>(null);
  const pendingAskUserQuestionRequestsRef = useRef<AskUserQuestionRequest[]>([]);

  // PlanApproval dialog state
  const [planApprovalDialogOpen, setPlanApprovalDialogOpen] = useState(false);
  const [currentPlanApprovalRequest, setCurrentPlanApprovalRequest] = useState<PlanApprovalRequest | null>(null);
  const planApprovalDialogOpenRef = useRef(false);
  const currentPlanApprovalRequestRef = useRef<PlanApprovalRequest | null>(null);
  const pendingPlanApprovalRequestsRef = useRef<PlanApprovalRequest[]>([]);

  // Rewind dialog state
  const [rewindDialogOpen, setRewindDialogOpen] = useState(false);
  const [currentRewindRequest, setCurrentRewindRequest] = useState<RewindRequest | null>(null);
  const [isRewinding, setIsRewinding] = useState(false);

  // Rewind select dialog state
  const [rewindSelectDialogOpen, setRewindSelectDialogOpen] = useState(false);

  // Context usage dialog state
  const [contextUsageDialogOpen, setContextUsageDialogOpen] = useState(false);
  const [contextUsageIsLoading, setContextUsageIsLoading] = useState(false);
  const [contextUsageData, setContextUsageData] = useState<ContextUsageData | null>(null);
  const contextUsageRequestIdRef = useRef<string | null>(null);

  // Sync refs with state
  useEffect(() => {
    permissionDialogOpenRef.current = permissionDialogOpen;
    currentPermissionRequestRef.current = currentPermissionRequest;
  }, [permissionDialogOpen, currentPermissionRequest]);

  useEffect(() => {
    askUserQuestionDialogOpenRef.current = askUserQuestionDialogOpen;
    currentAskUserQuestionRequestRef.current = currentAskUserQuestionRequest;
  }, [askUserQuestionDialogOpen, currentAskUserQuestionRequest]);

  useEffect(() => {
    planApprovalDialogOpenRef.current = planApprovalDialogOpen;
    currentPlanApprovalRequestRef.current = currentPlanApprovalRequest;
  }, [planApprovalDialogOpen, currentPlanApprovalRequest]);

  // Open permission dialog
  const openPermissionDialog = useCallback((request: PermissionRequest) => {
    // If a permission dialog is currently open, enqueue the new request instead of overriding.
    // This avoids losing follow-up requests when the user denies the current one.
    if (permissionDialogOpenRef.current || currentPermissionRequestRef.current) {
      const currentId = currentPermissionRequestRef.current?.channelId;
      const alreadyQueued = pendingPermissionRequestsRef.current.some(
        (item) => item.channelId === request.channelId
      );
      if (request.channelId !== currentId && !alreadyQueued) {
        pendingPermissionRequestsRef.current.push(request);
      }
      return;
    }

    currentPermissionRequestRef.current = request;
    permissionDialogOpenRef.current = true;
    setCurrentPermissionRequest(request);
    setPermissionDialogOpen(true);
  }, []);

  // Open ask user question dialog
  const openAskUserQuestionDialog = useCallback((request: AskUserQuestionRequest) => {
    // If an ask user question dialog is currently open, enqueue the new request instead of overriding.
    // This avoids losing follow-up requests when multiple questions arrive in quick succession.
    if (askUserQuestionDialogOpenRef.current || currentAskUserQuestionRequestRef.current) {
      const currentId = currentAskUserQuestionRequestRef.current?.requestId;
      const alreadyQueued = pendingAskUserQuestionRequestsRef.current.some(
        (item) => item.requestId === request.requestId
      );
      if (request.requestId !== currentId && !alreadyQueued) {
        pendingAskUserQuestionRequestsRef.current.push(request);
      }
      return;
    }

    currentAskUserQuestionRequestRef.current = request;
    askUserQuestionDialogOpenRef.current = true;
    setCurrentAskUserQuestionRequest(request);
    setAskUserQuestionDialogOpen(true);
  }, []);

  // Open plan approval dialog
  const openPlanApprovalDialog = useCallback((request: PlanApprovalRequest) => {
    // If a plan approval dialog is currently open, enqueue the new request instead of overriding.
    // This avoids losing follow-up requests when multiple plan approval requests arrive in quick succession.
    if (planApprovalDialogOpenRef.current || currentPlanApprovalRequestRef.current) {
      const currentId = currentPlanApprovalRequestRef.current?.requestId;
      const alreadyQueued = pendingPlanApprovalRequestsRef.current.some(
        (item) => item.requestId === request.requestId
      );
      if (request.requestId !== currentId && !alreadyQueued) {
        pendingPlanApprovalRequestsRef.current.push(request);
      }
      return;
    }

    currentPlanApprovalRequestRef.current = request;
    planApprovalDialogOpenRef.current = true;
    setCurrentPlanApprovalRequest(request);
    setPlanApprovalDialogOpen(true);
  }, []);

  // Process pending permission requests queue
  useEffect(() => {
    if (permissionDialogOpen) return;
    if (currentPermissionRequest) return;
    const next = pendingPermissionRequestsRef.current.shift();
    if (next) {
      openPermissionDialog(next);
    }
  }, [permissionDialogOpen, currentPermissionRequest, openPermissionDialog]);

  // Process pending ask user question requests queue
  useEffect(() => {
    if (askUserQuestionDialogOpen) return;
    if (currentAskUserQuestionRequest) return;
    const next = pendingAskUserQuestionRequestsRef.current.shift();
    if (next) {
      openAskUserQuestionDialog(next);
    }
  }, [askUserQuestionDialogOpen, currentAskUserQuestionRequest, openAskUserQuestionDialog]);

  // Process pending plan approval requests queue
  useEffect(() => {
    if (planApprovalDialogOpen) return;
    if (currentPlanApprovalRequest) return;
    const next = pendingPlanApprovalRequestsRef.current.shift();
    if (next) {
      openPlanApprovalDialog(next);
    }
  }, [planApprovalDialogOpen, currentPlanApprovalRequest, openPlanApprovalDialog]);

  // Permission handlers
  const handlePermissionApprove = useCallback((channelId: string) => {
    const payload = JSON.stringify({
      channelId,
      allow: true,
      remember: false,
      rejectMessage: null,
    });
    sendBridgeEvent('permission_decision', payload);
    pendingPermissionRequestsRef.current = pendingPermissionRequestsRef.current.filter(
      (item) => item.channelId !== channelId
    );
    permissionDialogOpenRef.current = false;
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  }, []);

  const handlePermissionApproveAlways = useCallback((channelId: string) => {
    const payload = JSON.stringify({
      channelId,
      allow: true,
      remember: true,
      rejectMessage: null,
    });
    sendBridgeEvent('permission_decision', payload);
    pendingPermissionRequestsRef.current = pendingPermissionRequestsRef.current.filter(
      (item) => item.channelId !== channelId
    );
    permissionDialogOpenRef.current = false;
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  }, []);

  const handlePermissionSkip = useCallback((channelId: string) => {
    const payload = JSON.stringify({
      channelId,
      allow: false,
      remember: false,
      rejectMessage: t('permission.userDenied'),
    });
    sendBridgeEvent('permission_decision', payload);
    pendingPermissionRequestsRef.current = pendingPermissionRequestsRef.current.filter(
      (item) => item.channelId !== channelId
    );
    permissionDialogOpenRef.current = false;
    currentPermissionRequestRef.current = null;
    setPermissionDialogOpen(false);
    setCurrentPermissionRequest(null);
  }, [t]);

  // AskUserQuestion handlers
  const handleAskUserQuestionSubmit = useCallback((requestId: string, answers: Record<string, string | string[]>) => {
    const payload = JSON.stringify({
      requestId,
      answers,
    });
    sendBridgeEvent('ask_user_question_response', payload);
    askUserQuestionDialogOpenRef.current = false;
    currentAskUserQuestionRequestRef.current = null;
    setAskUserQuestionDialogOpen(false);
    setCurrentAskUserQuestionRequest(null);
  }, []);

  const handleAskUserQuestionCancel = useCallback((requestId: string) => {
    const payload = JSON.stringify({
      requestId,
      answers: {},
    });
    sendBridgeEvent('ask_user_question_response', payload);
    askUserQuestionDialogOpenRef.current = false;
    currentAskUserQuestionRequestRef.current = null;
    setAskUserQuestionDialogOpen(false);
    setCurrentAskUserQuestionRequest(null);
  }, []);

  // PlanApproval handlers
  const handlePlanApprovalApprove = useCallback((requestId: string, targetMode: string) => {
    const payload = JSON.stringify({
      requestId,
      approved: true,
      targetMode,
    });
    sendBridgeEvent('plan_approval_response', payload);
    planApprovalDialogOpenRef.current = false;
    currentPlanApprovalRequestRef.current = null;
    setPlanApprovalDialogOpen(false);
    setCurrentPlanApprovalRequest(null);
  }, []);

  const handlePlanApprovalReject = useCallback((requestId: string) => {
    const payload = JSON.stringify({
      requestId,
      approved: false,
      targetMode: 'default',
    });
    sendBridgeEvent('plan_approval_response', payload);
    planApprovalDialogOpenRef.current = false;
    currentPlanApprovalRequestRef.current = null;
    setPlanApprovalDialogOpen(false);
    setCurrentPlanApprovalRequest(null);
  }, []);

  // Context usage dialog handlers
  const isCurrentContextUsageRequest = useCallback((requestId?: string | null) => {
    if (requestId == null || requestId === '') {
      return true;
    }
    return contextUsageRequestIdRef.current === requestId;
  }, []);

  const openContextUsageDialog = useCallback((requestId?: string | null, loading = true) => {
    contextUsageRequestIdRef.current = requestId ?? null;
    setContextUsageData(null);
    setContextUsageIsLoading(loading);
    setContextUsageDialogOpen(true);
  }, []);

  const updateContextUsageData = useCallback((requestId: string | null | undefined, data: ContextUsageData) => {
    if (!isCurrentContextUsageRequest(requestId)) {
      return false;
    }
    setContextUsageIsLoading(false);
    setContextUsageData(data);
    return true;
  }, [isCurrentContextUsageRequest]);

  const closeContextUsageDialog = useCallback((requestId?: string | null) => {
    if (!isCurrentContextUsageRequest(requestId)) {
      return false;
    }
    contextUsageRequestIdRef.current = null;
    setContextUsageDialogOpen(false);
    setContextUsageIsLoading(false);
    setContextUsageData(null);
    return true;
  }, [isCurrentContextUsageRequest]);

  return {
    // Permission dialog
    permissionDialogOpen,
    currentPermissionRequest,
    openPermissionDialog,
    handlePermissionApprove,
    handlePermissionApproveAlways,
    handlePermissionSkip,

    // AskUserQuestion dialog
    askUserQuestionDialogOpen,
    currentAskUserQuestionRequest,
    openAskUserQuestionDialog,
    handleAskUserQuestionSubmit,
    handleAskUserQuestionCancel,

    // PlanApproval dialog
    planApprovalDialogOpen,
    currentPlanApprovalRequest,
    openPlanApprovalDialog,
    handlePlanApprovalApprove,
    handlePlanApprovalReject,

    // Rewind dialog
    rewindDialogOpen,
    setRewindDialogOpen,
    currentRewindRequest,
    setCurrentRewindRequest,
    isRewinding,
    setIsRewinding,

    // Rewind select dialog
    rewindSelectDialogOpen,
    setRewindSelectDialogOpen,

    // Context usage dialog
    contextUsageDialogOpen,
    contextUsageIsLoading,
    contextUsageData,
    openContextUsageDialog,
    updateContextUsageData,
    closeContextUsageDialog,
  };
}
