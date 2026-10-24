import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Button from 'antd/es/button';
import Input from 'antd/es/input';
import Select from 'antd/es/select';
import Checkbox from 'antd/es/checkbox';
import ConfigProvider from 'antd/es/config-provider';
import Popover from 'antd/es/popover';
import { theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { sendOfficeCommand, sendOfficeRequest } from './officeBridge';
import { OfficeAnimationClock } from './officeAnimation';
import { OfficeSceneReceiver } from './officeSceneReceiver';
import { OfficeLiveAssetPool } from './officeLiveAssets';
import { OfficeBackgroundManager } from './officeBackgrounds';
import type { OfficeBackgroundState } from './officeBackgrounds';
import { OfficeSeatAllocator, presentSource } from './officeLiveModel';
import type { LiveScene, LiveSource } from './officeLiveModel';
import { filterOfficeSources, OFFICE_FLOOR_CAPACITY, officeFloorSources, phaseColor } from './officeModel';
import { drawOfficeScene, hitTestOffice, officeSceneHeight, OFFICE_SCENE_WIDTH } from './officeRenderer';
import type { OfficeHitRegion } from './officeRenderer';
import { OFFICE_THEME_IDS, readOfficeThemePreferences, writeOfficeThemePreferences } from './officeThemes';
import type { OfficeThemeId } from './officeThemes';
import { OFFICE_MIB, readOfficeCachePreferences, writeOfficeCachePreferences, validOfficeCacheLimit } from './officeCachePreferences';
import { OfficeNativeStorage, OfficeSharedPreferencesController, parseOfficeSharedState } from './officeSharedStorage';
import { OfficeZoomControl } from './OfficeZoomControl';
import { fitOfficeSceneWidth, useOfficeViewport } from './officeViewport';
import { officeArtCamera, officeCameraPoint } from './officeCamera';
import type { OfficeCamera } from './officeCamera';
import { OfficeVectorScene } from './OfficeVectorScene';
import { OFFICE_ART_SEATS } from './officeArtGeometry';
import { OfficeRecentResults } from './OfficeRecentResults';
import { OfficeDeskPreview } from './OfficeDeskPreview';
import { OfficeTransitions } from './officeTransitions';
import { OfficeAppearanceControl } from './OfficeAppearanceControl';
import { editOfficeAppearanceOverride } from './officeAppearanceOverrides';
import type { OfficeAppearanceOverrides, OfficePetChoice } from './officeAppearanceOverrides';
import { useOfficeDeskHover } from './useOfficeDeskHover';
import { OfficeFeedback } from './officeFeedback';
import { OfficeFeedbackLayer } from './officeFeedbackLayer';
import { OfficeSettings } from './OfficeSettings';
import type { OfficePresentationSetting } from './OfficeSettings';
import { parseOfficeName, readOfficeName, writeOfficeName } from './officeName';
import { OfficeEffectsControl } from './OfficeEffectsControl';
import { OfficeMarginEffects, officeMarginLayout, readOfficeMarginPreferences, writeOfficeMarginPreferences } from './officeMarginEffects';
import type { OfficeMarginLayout, OfficeMarginPreferences } from './officeMarginEffects';
import { OFFICE_CUSTOM_UI, OFFICE_UI_PALETTES, officeUiStyle, readOfficePresentation, writeOfficePresentation } from './officePresentation';
import type { OfficePresentationPreferences, OfficeUiPalette } from './officePresentation';
import { OfficeWindowScenery } from './officeWindowScenery';

interface SceneState { scene: LiveScene; receivedAt: number }
/** Dedicated local scene. It never imports the chat Webview or exposes task/approval commands. */
export function LiveOffice() {
  const { t } = useTranslation('petOffice');
  const [sharedInitial] = useState(() => window.__PET_OFFICE_BOOTSTRAP__?.sharedPreferences
    ? parseOfficeSharedState(window.__PET_OFFICE_BOOTSTRAP__.sharedPreferences) : null);
  const initial = sharedInitial?.preferences;
  const [officeNamePreferences, setOfficeNamePreferences] = useState(() => initial ? { name: initial.officeName, error: false } : readOfficeName());
  const officeName = officeNamePreferences.name;
  const [officeNameDraft, setOfficeNameDraft] = useState(officeName);
  let validOfficeName = true;
  try { parseOfficeName(officeNameDraft); } catch { validOfficeName = false; }
  const officeTitle = officeName || t('title');
  const [sharedError, setSharedError] = useState(false);
  const [presentationPending, setPresentationPending] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const sharedRef = useRef<OfficeSharedPreferencesController | null>(null);
  const nativeStorageRef = useRef<OfficeNativeStorage | null>(null);
  const [appearanceOverrides, setAppearanceOverrides] = useState<OfficeAppearanceOverrides>(() => initial?.appearanceOverrides ?? {});
  const [petChoices, setPetChoices] = useState<OfficePetChoice[]>([{ id: 'builtin', label: 'Built-in robot' }]);
  const [choicesLoading, setChoicesLoading] = useState(false);
  const [choicesError, setChoicesError] = useState(false);
  const choicesLoadedRef = useRef(false);
  const choicesLoadingRef = useRef(false);
  const [snapshot, setSnapshot] = useState<SceneState | null>(null);
  const [now, setNow] = useState(() => performance.now());
  const [showIdle, setShowIdle] = useState(initial?.showIdle ?? false);
  const [product, setProduct] = useState(initial?.product ?? 'all');
  const [search, setSearch] = useState(initial?.search ?? '');
  const [floor, setFloor] = useState(initial?.floor ?? 0);
  const [focusDesks, setFocusDesks] = useState(true);
  const [zoom, setZoom] = useState(initial?.zoom ?? 100);
  const [selected, setSelected] = useState<string | null>(null);
  const { preview, inspect: inspectDesk, dismiss: dismissDesk } = useOfficeDeskHover();
  const transitionsRef = useRef(new OfficeTransitions());
  const transitionPendingRef = useRef(false);
  const retainedCountRef = useRef(0);
  const [transitionPending, setTransitionPending] = useState(false);
  const [paused, setPaused] = useState(initial?.paused ?? false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [presentation, setPresentation] = useState(() => initial?.presentation ?? readOfficePresentation());
  const [presentationError, setPresentationError] = useState(false);
  const [marginEffects, setMarginEffects] = useState(readOfficeMarginPreferences);
  const [marginEffectsError, setMarginEffectsError] = useState(false);
  const marginEffectsRef = useRef(new OfficeMarginEffects());
  const marginLeftRef = useRef<HTMLCanvasElement>(null);
  const marginRightRef = useRef<HTMLCanvasElement>(null);
  const [nativeVisible, setNativeVisible] = useState(false);
  const [syncError, setSyncError] = useState('');
  const [navigation, setNavigation] = useState('');
  const [navPending, setNavPending] = useState(false);
  const [assetVersion, setAssetVersion] = useState(0);
  const [pinned, setPinned] = useState(() => initial?.topmost ?? window.__PET_OFFICE_BOOTSTRAP__?.alwaysOnTop ?? true);
  const [background, setBackground] = useState<OfficeBackgroundState>({ floor: 0, custom: false, busy: false, error: '' });
  const [themePreferences, setThemePreferences] = useState(() => initial ? { floors: initial.floors, error: false } : readOfficeThemePreferences());
  const [cachePreferences, setCachePreferences] = useState(() => initial ? { limitMiB: initial.limitMiB, error: false } : readOfficeCachePreferences());
  const [cacheDraft, setCacheDraft] = useState<number | null>(() => cachePreferences.limitMiB);
  const cacheBudgetRef = useRef(cachePreferences.limitMiB * OFFICE_MIB);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const svgRefs = useRef<SVGSVGElement[]>([]);
  const windowSceneryRef = useRef(new OfficeWindowScenery());
  const paintedCameraRef = useRef<OfficeCamera | null>(null);
  const visualTimeRef = useRef({ elapsed: 0, last: 0 });
  const feedbackRef = useRef(new OfficeFeedback());
  const feedbackLayerRef = useRef(new OfficeFeedbackLayer());
  const feedbackRootRef = useRef<HTMLDivElement>(null);
  const feedbackLabelsRef = useRef<Record<string, string>>({});
  const viewportRef = useRef<HTMLDivElement>(null);
  const statsRef = useRef<HTMLSpanElement>(null);
  const receiverRef = useRef<OfficeSceneReceiver | null>(null);
  const poolRef = useRef<OfficeLiveAssetPool | null>(null);
  const backgroundRef = useRef<OfficeBackgroundManager | null>(null);
  const backgroundInput = useRef<HTMLInputElement>(null);
  const clockRef = useRef<OfficeAnimationClock | null>(null);
  const hitsRef = useRef<OfficeHitRegion[]>([]);
  const allocator = useRef(new OfficeSeatAllocator());
  const nativeRef = useRef(false);
  const pausedRef = useRef(paused || reducedMotion);
  const reducedMotionRef = useRef(reducedMotion);
  const sceneRef = useRef<{ visible: LiveSource[]; selected: string | null; registered: number; stale: boolean; theme: OfficeThemeId; height: number; camera?: OfficeCamera; vectorTheme?: OfficeThemeId;
    presentation: OfficePresentationPreferences; palette: OfficeUiPalette; motion: boolean; transitionContext: string;
    marginEffects: OfficeMarginPreferences; marginLayout: OfficeMarginLayout; reducedMotion: boolean }>({ visible: [], selected: null, registered: 0, stale: true, theme: 'loft', height: officeSceneHeight([]), presentation, palette: OFFICE_CUSTOM_UI, motion: false, transitionContext: '', marginEffects, marginLayout: officeMarginLayout(0, 0, 0, 1), reducedMotion });
  const pendingNavigation = useRef<{ id: string; startedAt: number; sourceKey: string } | null>(null);
  const stale = !snapshot || now - snapshot.receivedAt >= 15_000;
  const sources = useMemo(() => snapshot?.scene.sources.map(source => presentSource(source, Math.max(0, now - snapshot.receivedAt), stale)) ?? [], [snapshot, now, stale]);
  const seated = useMemo(() => allocator.current.assign(sources, showIdle), [sources, showIdle]);
  const filtered = useMemo(() => filterOfficeSources(seated, product, search) as LiveSource[], [seated, product, search]);
  const floors = Math.max(1, Math.ceil((Math.max(-1, ...seated.map(source => source.seat)) + 1) / OFFICE_FLOOR_CAPACITY));
  const currentFloor = Math.min(floor, floors - 1);
  const currentTheme = themePreferences.floors[currentFloor] ?? 'loft';
  const visible = useMemo(() => officeFloorSources(filtered, currentFloor) as LiveSource[], [filtered, currentFloor]);
  const currentSource = sources.find(source => source.sourceKey === selected);
  const previewSource = !stale && nativeVisible && !settingsOpen && !diagnosticsOpen ? visible.find(source => source.sourceKey === preview?.sourceKey) : undefined;
  const selectedSeat = visible.find(source => source.sourceKey === selected)?.seat;
  const height = officeSceneHeight(visible, !background.custom);
  const viewport = useOfficeViewport(viewportRef);
  const vectorTheme = background.custom ? undefined : currentTheme;
  const camera = vectorTheme ? officeArtCamera(visible, vectorTheme, viewport.width / viewport.height, focusDesks, selected)
    : { x: 0, y: 0, width: OFFICE_SCENE_WIDTH, height };
  const viewBox = `${camera.x} ${camera.y} ${camera.width} ${camera.height}`;
  const fitWidth = fitOfficeSceneWidth(viewport.width, viewport.height, camera.height, camera.width);
  const marginLayout = officeMarginLayout(viewport.width, viewport.height, Math.max(1, Math.round(fitWidth * zoom / 100)), devicePixelRatio || 1);
  const products = useMemo(() => [...new Set(sources.map(source => source.product))].sort(), [sources]);
  const palette = background.custom ? OFFICE_CUSTOM_UI : OFFICE_UI_PALETTES[currentTheme];
  const canAnimate = nativeVisible && !paused && !reducedMotion && !stale;
  const motion = canAnimate && (visible.length > 0 || transitionPending);
  const transitionContext = JSON.stringify([snapshot?.scene.instanceId, snapshot?.scene.connectionEpoch, currentFloor, vectorTheme, product, search, showIdle]);
  const attention = feedbackRef.current.attention(now, presentation.attention && !stale, false);
  nativeRef.current = nativeVisible;
  pausedRef.current = paused || reducedMotion;
  reducedMotionRef.current = reducedMotion;
  feedbackLabelsRef.current = { SUCCEEDED: t('phase.SUCCEEDED'), FAILED: t('phase.FAILED'), CANCELLED: t('phase.CANCELLED'), WAITING_USER: t('needsAttention') };
  sceneRef.current = { visible, selected, registered: sources.length, stale, theme: currentTheme, height, camera, vectorTheme, presentation, palette, motion, transitionContext, marginEffects, marginLayout, reducedMotion };

  const paint = useCallback((time: number) => {
    const state = sceneRef.current;
    const transitions = transitionsRef.current;
    const actors = transitions.frame(time);
    const actorMotions = new Map(actors.map(actor => [actor.source.sourceKey, actor.motion]));
    const retained = transitions.retained();
    if (retained.length !== retainedCountRef.current) { retainedCountRef.current = retained.length; poolRef.current?.demand(state.visible, retained); }
    if (transitionPendingRef.current && !transitions.pending(time)) { transitionPendingRef.current = false; setTransitionPending(false); }
    const alpha = String(transitions.sceneAlpha(time));
    if (surfaceRef.current && surfaceRef.current.style.opacity !== alpha) surfaceRef.current.style.opacity = alpha;
    const moving = state.motion && document.visibilityState === 'visible';
    const visual = visualTimeRef.current;
    if (moving && visual.last) visual.elapsed += Math.max(0, Math.min(100, time - visual.last));
    visual.last = moving ? time : 0;
    windowSceneryRef.current.draw(visual.elapsed, state.presentation.ambience && !state.reducedMotion);
    marginEffectsRef.current.draw([marginLeftRef.current, marginRightRef.current], state.marginLayout,
      state.marginEffects.enabled && state.visible.length > 0 && !state.stale && !state.reducedMotion ? state.marginEffects.mode : null, visual.elapsed, state.palette);
    const view = state.camera ?? { x: 0, y: 0, width: OFFICE_SCENE_WIDTH, height: state.height };
    paintedCameraRef.current = view;
    const viewBox = `${view.x} ${view.y} ${view.width} ${view.height}`;
    for (const svg of svgRefs.current) if (svg.getAttribute('viewBox') !== viewBox) svg.setAttribute('viewBox', viewBox);
    const visibleKeys = new Set(state.visible.map(source => source.sourceKey));
    const attention = feedbackRef.current.attention(time, state.presentation.attention && !state.stale, moving && state.presentation.effects, visibleKeys);
    const effects = state.presentation.effects && moving ? feedbackRef.current.active(time) : [];
    const canvas = canvasRef.current;
    if (canvas) hitsRef.current = drawOfficeScene(canvas, actors.map(actor => actor.source), state.selected, visual.elapsed, source => {
      const live = source as LiveSource;
      const actor = poolRef.current?.visual(live, effects.some(effect => effect.identity === live.terminalEventId));
      return { ...actor, frame: actor?.frame ?? (() => null), motion: actorMotions.get(live.sourceKey) };
    }, backgroundRef.current?.visual(), state.theme, state.height, view, state.vectorTheme,
    { palette: state.palette, ambience: state.presentation.ambience, effectTime: time, effects, attention });
    feedbackLayerRef.current.sync(feedbackRootRef.current, effects, hitsRef.current, view, time, feedbackLabelsRef.current);
  }, []);

  useEffect(() => {
    let disposed = false;
    const pool = new OfficeLiveAssetPool({
      request: reference => sendOfficeRequest('asset', { requestId: reference.requestId, sourceKey: reference.sourceKey, appearanceRevision: reference.appearanceRevision, assetDigest: reference.manifest.digest }),
      changed: () => { if (!disposed) setAssetVersion(version => version + 1); },
      externalDecodedBytes: () => backgroundRef.current?.decodedBytes() ?? 0,
      decodedBudgetBytes: () => cacheBudgetRef.current,
    });
    poolRef.current = pool;
    const nativeStorage = sharedInitial ? new OfficeNativeStorage() : undefined;
    nativeStorageRef.current = nativeStorage ?? null;
    const backgrounds = new OfficeBackgroundManager({
      storage: nativeStorage,
      usedBytes: () => pool.decodedBytes(),
      decodedBudgetBytes: () => cacheBudgetRef.current,
      changed: state => { if (!disposed) { setBackground(state); setAssetVersion(version => version + 1); if (!state.busy) pool.retry(); } },
    });
    backgroundRef.current = backgrounds;
    if (sharedInitial && nativeStorage) {
      sharedRef.current = new OfficeSharedPreferencesController(sharedInitial, nativeStorage, (state, error, apply) => {
        if (disposed) return;
        setSharedError(error);
        if (apply) {
          const p = state.preferences;
          setShowIdle(p.showIdle); setProduct(p.product); setSearch(p.search); setFloor(p.floor); setPaused(p.paused); setPinned(p.topmost); setZoom(p.zoom);
          setPresentation(p.presentation); setAppearanceOverrides(p.appearanceOverrides);
          setOfficeNamePreferences({ name: p.officeName, error: false }); setOfficeNameDraft(p.officeName);
          setThemePreferences({ floors: p.floors, error: false }); setCachePreferences({ limitMiB: p.limitMiB, error: false }); setCacheDraft(p.limitMiB);
          cacheBudgetRef.current = p.limitMiB * OFFICE_MIB;
          pool.reconfigureBudget(); backgrounds.reconfigureBudget();
        }
      });
      window.petOfficePreferencesChanged = state => { try { sharedRef.current?.adopt(state); } catch { setSharedError(true); } };
    }
    const receiver = new OfficeSceneReceiver({
      page: window.__PET_OFFICE_BOOTSTRAP__?.pageGeneration ?? '', send: sendOfficeRequest,
      scene: (scene, receivedAt) => {
        const state = sceneRef.current;
        feedbackRef.current.accept(scene, receivedAt, nativeRef.current && !pausedRef.current && document.visibilityState === 'visible' && state.presentation.effects,
          new Set(state.visible.map(source => source.sourceKey)));
        pool.syncSources(scene.sources); setSnapshot({ scene, receivedAt }); setNow(receivedAt); setSyncError('');
      },
      assetAllowed: reference => pool.allowed(reference), asset: (reference, bytes) => pool.accept(reference, bytes),
      result: (id, result) => {
        pool.result(id, result);
        if (pendingNavigation.current?.id === id && performance.now() - pendingNavigation.current.startedAt < 3000) {
          const matches = pendingNavigation.current.sourceKey === sceneRef.current.selected;
          pendingNavigation.current = null; setNavPending(false); if (matches) setNavigation(result);
        }
      }, error: setSyncError,
    });
    receiverRef.current = receiver;
    const clock = new OfficeAnimationClock(paint, undefined, metrics => {
      if (statsRef.current) statsRef.current.textContent = `${metrics.fps.toFixed(1)} FPS · ${metrics.drawMs.toFixed(2)} ms`;
      if (nativeRef.current) sendOfficeCommand('metrics', { ...metrics, visibleSources: sceneRef.current.visible.length, decodedBytes: pool.decodedBytes() + backgrounds.decodedBytes() });
    });
    clockRef.current = clock;
    window.petOfficeReceive = packet => receiver.receive(packet);
    window.petOfficeSetVisible = visible => { setNow(performance.now()); setNativeVisible(visible); };
    window.petOfficeSetTopmost = topmost => { if (!sharedInitial && typeof topmost === 'boolean') setPinned(topmost); };
    window.petOfficeDiagnostics = () => ({ ...clock.getMetrics(), sourceCount: sceneRef.current.registered, visibleSources: sceneRef.current.visible.length,
      decodedBytes: pool.decodedBytes() + backgrounds.decodedBytes(), decodedLimitBytes: cacheBudgetRef.current, backgroundCustom: !!backgrounds.visual(), artworkTheme: sceneRef.current.vectorTheme ?? '', vectorScene: !!sceneRef.current.vectorTheme, cameraX: paintedCameraRef.current?.x ?? 0, cameraY: paintedCameraRef.current?.y ?? 0, cameraWidth: paintedCameraRef.current?.width ?? OFFICE_SCENE_WIDTH, cameraHeight: paintedCameraRef.current?.height ?? sceneRef.current.height, assetRequests: pool.inFlight(), nativeVisible: nativeRef.current, simulated: false, stale: sceneRef.current.stale,
      taskEffects: feedbackRef.current.active(performance.now()).length, waitingAttention: feedbackRef.current.attention(performance.now(), sceneRef.current.presentation.attention, false).size,
      ambientMotion: sceneRef.current.presentation.ambience && sceneRef.current.motion && !!sceneRef.current.vectorTheme, reducedMotion: reducedMotionRef.current,
      ...marginEffectsRef.current.diagnostics(), marginEffectMode: sceneRef.current.marginEffects.enabled ? sceneRef.current.marginEffects.mode : 'off',
      marginEffectActive: marginEffectsRef.current.diagnostics().marginEffectVisible && sceneRef.current.motion && document.visibilityState === 'visible',
      hitTargets: hitsRef.current.length, retiringActors: transitionsRef.current.retained().length, presentationTransition: transitionsRef.current.pending(performance.now()),
      logicalHeight: sceneRef.current.height, petImages: pool.diagnostics().images, optimizedImages: pool.diagnostics().optimized, fallbackPets: pool.diagnostics().fallback });
    const interval = window.setInterval(() => {
      receiver.poll(); pool.poll(); setNow(performance.now());
      if (pendingNavigation.current && performance.now() - pendingNavigation.current.startedAt >= 3000) {
        const matches = pendingNavigation.current.sourceKey === sceneRef.current.selected;
        pendingNavigation.current = null; setNavPending(false); if (matches) setNavigation('UNAVAILABLE');
      }
    }, 1000);
    sendOfficeCommand('ready');
    return () => {
      disposed = true; nativeStorageRef.current = null; sharedRef.current?.dispose(); sharedRef.current = null;
      window.clearInterval(interval); receiver.dispose(); pool.dispose(); backgrounds.dispose(); clock.dispose();
      receiverRef.current = null; poolRef.current = null; backgroundRef.current = null; clockRef.current = null; pendingNavigation.current = null;
      delete window.petOfficeReceive; delete window.petOfficeSetVisible; delete window.petOfficeSetTopmost; delete window.petOfficeDiagnostics;
      delete window.petOfficePreferencesChanged;
    };
  }, [paint, sharedInitial]);

  useEffect(() => {
    sharedRef.current?.save({ officeName, limitMiB: cachePreferences.limitMiB, floors: themePreferences.floors, floor, product, search, showIdle, paused, topmost: pinned, zoom, presentation, appearanceOverrides });
  }, [officeName, cachePreferences.limitMiB, themePreferences.floors, floor, product, search, showIdle, paused, pinned, zoom, presentation, appearanceOverrides]);

  useEffect(() => { document.title = officeTitle; }, [officeTitle]);

  const loadPetChoices = useCallback(async () => {
    const storage = nativeStorageRef.current;
    if (!storage || choicesLoadingRef.current) return;
    choicesLoadingRef.current = true; setChoicesLoading(true); setChoicesError(false);
    try {
      const choices = await storage.request('petChoices', {}) as OfficePetChoice[];
      if (nativeStorageRef.current === storage) { setPetChoices(choices); choicesLoadedRef.current = true; }
    } catch { if (nativeStorageRef.current === storage) setChoicesError(true); }
    finally { if (nativeStorageRef.current === storage) { choicesLoadingRef.current = false; setChoicesLoading(false); } }
  }, []);
  useEffect(() => {
    if (currentSource && !choicesLoadedRef.current) void loadPetChoices();
  }, [currentSource?.sourceKey, loadPetChoices]);
  const changeAppearance = (id: string) => {
    if (!currentSource || stale || !sharedRef.current) return;
    try { setAppearanceOverrides(editOfficeAppearanceOverride(appearanceOverrides, currentSource.sourceKey, id, new Set(sources.map(source => source.sourceKey)))); }
    catch { setSharedError(true); }
  };

  const finishPresentation = async (command: 'hide' | 'exit') => {
    if (presentationPending) return;
    const controller = sharedRef.current;
    if (!controller) { sendOfficeCommand(command); return; }
    setPresentationPending(true);
    try {
      await controller.flushPending();
      if (sharedRef.current === controller) sendOfficeCommand(command);
    } finally { if (sharedRef.current === controller) setPresentationPending(false); }
  };

  useEffect(() => { backgroundRef.current?.show(currentFloor); }, [currentFloor]);
  useEffect(() => { dismissDesk(); }, [currentFloor, currentTheme, search, product, nativeVisible, stale, settingsOpen, diagnosticsOpen, dismissDesk]);
  useEffect(() => { if (preview && !previewSource) dismissDesk(); }, [preview?.sourceKey, previewSource?.sourceKey, dismissDesk]);
  useLayoutEffect(() => {
    const root = document.documentElement;
    for (const [name, value] of Object.entries(palette)) root.style.setProperty(`--office-${name}`, value);
    return () => { for (const name of Object.keys(palette)) root.style.removeProperty(`--office-${name}`); };
  }, [palette]);
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const change = () => setReducedMotion(media.matches);
    media.addEventListener('change', change);
    return () => media.removeEventListener('change', change);
  }, []);

  useLayoutEffect(() => {
    transitionsRef.current.sync(visible, transitionContext, performance.now(), canAnimate && document.visibilityState === 'visible');
    const pending = transitionsRef.current.pending(performance.now());
    transitionPendingRef.current = pending; setTransitionPending(pending);
    const retained = transitionsRef.current.retained(); retainedCountRef.current = retained.length;
    poolRef.current?.demand(visible, retained);
  }, [visible, transitionContext, canAnimate]);
  useEffect(() => {
    const update = () => {
      const state = sceneRef.current;
      const active = nativeRef.current && !pausedRef.current && !state.stale && document.visibilityState === 'visible'
        && (state.visible.length > 0 || transitionsRef.current.pending(performance.now()));
      clockRef.current?.setActive(active);
      if (!active) {
        feedbackLayerRef.current.clear();
        feedbackRef.current.clearEffects();
        const state = sceneRef.current; transitionsRef.current.sync(state.visible, state.transitionContext, performance.now(), false);
        transitionPendingRef.current = false; setTransitionPending(false);
        poolRef.current?.demand(state.visible); retainedCountRef.current = 0;
      }
      if (nativeVisible && document.visibilityState === 'visible') paint(performance.now());
    };
    update(); document.addEventListener('visibilitychange', update);
    return () => { document.removeEventListener('visibilitychange', update); clockRef.current?.setActive(false); feedbackLayerRef.current.clear(); };
  }, [nativeVisible, motion, paint]);
  useLayoutEffect(() => {
    svgRefs.current = [...(surfaceRef.current?.querySelectorAll<SVGSVGElement>('.office-vector-scene') ?? [])];
    const scenery = windowSceneryRef.current;
    scenery.bind(surfaceRef.current?.querySelector<SVGSVGElement>('.office-vector-environment') ?? null, vectorTheme);
    feedbackRef.current.clearEffects(); feedbackLayerRef.current.clear();
    return () => scenery.dispose();
  }, [vectorTheme, currentFloor]);
  useEffect(() => { if (nativeVisible && document.visibilityState === 'visible') paint(performance.now()); }, [visible, selected, assetVersion, currentTheme, nativeVisible, camera.x, camera.y, camera.width, camera.height, presentation, reducedMotion, marginEffects, viewport.width, viewport.height, fitWidth, zoom, paint]);
  useEffect(() => {
    const viewport = viewportRef.current, surface = surfaceRef.current;
    if (!viewport || !surface || selectedSeat === undefined || !focusDesks || !vectorTheme) return;
    const seat = OFFICE_ART_SEATS[vectorTheme][selectedSeat % OFFICE_FLOOR_CAPACITY];
    viewport.scrollTo({ left: (seat.x - camera.x) * surface.clientWidth / camera.width - viewport.clientWidth / 2,
      top: ((seat.y - 72 * seat.scale + seat.label) / 2 - camera.y) * surface.clientHeight / camera.height - viewport.clientHeight / 2 });
  }, [selectedSeat, zoom, fitWidth, focusDesks, vectorTheme, camera.x, camera.y, camera.width, camera.height]);
  useEffect(() => {
    const canvas = canvasRef.current; if (!canvas) return;
    const resize = () => {
      canvas.width = Math.max(1, Math.round(canvas.clientWidth * Math.min(2, devicePixelRatio || 1)));
      canvas.height = Math.max(1, Math.round(canvas.clientHeight * Math.min(2, devicePixelRatio || 1)));
      if (nativeRef.current && document.visibilityState === 'visible') paint(performance.now());
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); window.addEventListener('resize', resize); resize();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [paint]);

  const selectSource = (key: string) => {
    const source = seated.find(source => source.sourceKey === key); if (source) setFloor(Math.floor(source.seat / OFFICE_FLOOR_CAPACITY));
    setSelected(key); setNavigation('');
  };
  const navigate = (source: LiveSource | undefined, interaction: boolean) => {
    if (!source || stale || pendingNavigation.current || source.routeStatus !== 'AVAILABLE') return;
    const requestId = crypto.randomUUID(); pendingNavigation.current = { id: requestId, startedAt: performance.now(), sourceKey: source.sourceKey }; setNavPending(true); setNavigation('');
    sendOfficeRequest('navigate', { requestId, sourceKey: source.sourceKey, routeGeneration: source.routeGeneration, interactionId: interaction ? source.pendingInteractionId : '' });
  };
  const imageSummary = poolRef.current?.diagnostics() ?? { images: 0, optimized: 0, loading: 0, fallback: 0 };
  const imageIssues = visible.map(source => ({ source, status: poolRef.current?.status(source) ?? 'assetLoading' })).filter(item => !['READY', 'BUILTIN'].includes(item.status));
  const changeTheme = (theme: OfficeThemeId) => {
    const floors = [...themePreferences.floors]; floors[currentFloor] = theme;
    setThemePreferences({ floors, error: !sharedInitial && !writeOfficeThemePreferences(floors) });
  };
  const applyCacheLimit = () => {
    if (!validOfficeCacheLimit(cacheDraft)) return;
    cacheBudgetRef.current = cacheDraft * OFFICE_MIB;
    setCachePreferences({ limitMiB: cacheDraft, error: !sharedInitial && !writeOfficeCachePreferences(cacheDraft) });
    poolRef.current?.reconfigureBudget(); backgroundRef.current?.reconfigureBudget();
  };
  const applyOfficeName = () => {
    if (!validOfficeName) return;
    const name = officeNameDraft.trim();
    setOfficeNameDraft(name);
    setOfficeNamePreferences({ name, error: !sharedInitial && !writeOfficeName(name) });
  };
  const changePresentation = (name: OfficePresentationSetting, enabled: boolean) => {
    const next = { ...presentation, [name]: enabled };
    if (!enabled && (name === 'effects' || name === 'attention')) feedbackRef.current.clearEffects();
    setPresentation(next); setPresentationError(!sharedInitial && !writeOfficePresentation(next));
  };
  const changeMarginEffects = (value: OfficeMarginPreferences) => {
    setMarginEffects(value); setMarginEffectsError(!writeOfficeMarginPreferences(value));
  };

  return <ConfigProvider getPopupContainer={trigger => trigger?.closest<HTMLElement>('.office-live') ?? document.body} theme={{ algorithm: theme.darkAlgorithm, token: {
    colorPrimary: palette.accent, colorBgContainer: palette.surface, colorBgElevated: palette.surface, colorBgLayout: palette.background, colorBorder: palette.border,
    colorText: palette.text, colorTextSecondary: palette.muted, colorTextPlaceholder: palette.muted, controlItemBgActive: palette.selected,
    borderRadius: 8, fontSize: 14, fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' } }}>
    <main className="pet-office office-live" data-ui-theme={background.custom ? 'custom' : currentTheme} style={officeUiStyle(palette)} onKeyDown={event => { if (event.key === 'Escape') setDiagnosticsOpen(false); }}>
      <header className="office-header">
        <div className="office-brand"><div className="office-brand-icon" aria-hidden>▣</div><div><h1>{officeTitle}</h1><p>{t('subtitle')} {t('localNotice')}</p></div></div>
        <div className="office-header-actions">
          <div className="office-scene-actions"><Button onClick={() => { receiverRef.current?.resync(); poolRef.current?.retry(); }}>{t('refreshScene')}</Button><Button aria-pressed={paused || reducedMotion} disabled={reducedMotion} title={reducedMotion ? t('reducedMotionHint') : undefined} onClick={() => setPaused(value => !value)}>{t(paused || reducedMotion ? 'resume' : 'pause')}</Button></div>
          <div className="office-native-actions"><Button disabled={presentationPending} onClick={() => { void finishPresentation('hide'); }}>{t('hide')}</Button><Button disabled={presentationPending} onClick={() => { void finishPresentation('exit'); }}>{t('closeOffice')}</Button><Button className={`office-pin ${pinned ? 'is-pinned' : ''}`} aria-pressed={pinned} onClick={() => { if (sharedInitial) setPinned(value => !value); else sendOfficeRequest('setTopmost', { topmost: !pinned }); }}>{t(pinned ? 'unpinOffice' : 'pinOffice')}</Button></div>
        </div>
      </header>
      {stale || syncError || snapshot?.scene.capacityReached ? <div className="office-notice" role="status">{stale ? t('syncPending') : ''}{syncError ? <span className="office-warning"> {t(syncError)}</span> : null}{snapshot?.scene.capacityReached ? <span className="office-warning"> {t('capacityReached')}</span> : null}</div> : null}
      <div className="office-toolbar-row"><div className="office-toolbar"><span className="office-source-count">{t('realSources')} {sources.length}</span><Checkbox checked={showIdle} onChange={event => setShowIdle(event.target.checked)}>{t('showIdle')}</Checkbox>
        <Select aria-label={t('allProducts')} value={product} options={[{ value: 'all', label: t('allProducts') }, ...products.map(value => ({ value, label: value }))]} onChange={value => { setProduct(value); setFloor(0); }} />
        <Input.Search aria-label={t('search')} placeholder={t('search')} allowClear value={search} maxLength={160} onChange={event => setSearch(event.target.value)} /></div>
        <Popover trigger="click" placement="bottomRight" open={diagnosticsOpen} onOpenChange={setDiagnosticsOpen} title={<div className="office-diagnostics-heading"><span>{t('render')}</span><Button type="text" size="small" aria-label={t('closeDiagnostics')} onClick={() => setDiagnosticsOpen(false)}>×</Button></div>} classNames={{ root: 'office-diagnostics-popover' }} content={<div className="office-diagnostics-details">
          <h3>{t('imageDiagnostics')}</h3><p>{t('imageSummary', imageSummary)}</p>
          {imageIssues.length ? <ul className="office-image-issues">{imageIssues.map(({ source, status }) => <li key={source.sourceKey}><strong>{source.projectLabel} / {source.tabLabel}</strong> · {t(`assetStatus.${status}`, { limit: cachePreferences.limitMiB, defaultValue: t('imageError') })}</li>)}</ul> : <p>{t('imagesHealthy')}</p>}
          <p>{t('appearanceNotice')}</p><p>{t('roomResourceHint')}</p>
        </div>}>
          <button className="office-diagnostics" aria-label={t('render')} aria-expanded={diagnosticsOpen}>
            <span className="office-diagnostics-title">{t('render')}<svg aria-hidden="true" focusable="false" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 6v.5" /></svg></span>
            <span ref={statsRef}>0.0 FPS · 0.00 ms</span><span>{t('visible')} {visible.length}</span><span>{t('decoded')} {(((poolRef.current?.decodedBytes() ?? 0) + (backgroundRef.current?.decodedBytes() ?? 0)) / OFFICE_MIB).toFixed(1)} / {cachePreferences.limitMiB} MiB</span>
          </button>
        </Popover>
      </div>
      {sharedError ? <p className="office-warning" role="alert">{t('sharedPreferencesError')}</p> : null}
      <div className="office-workspace"><section className="office-scene-panel"><header className="office-scene-header" onFocusCapture={event => {
        if (!(event.target instanceof HTMLElement)) return;
        const header = event.currentTarget, control = event.target.closest<HTMLElement>('.ant-btn, .ant-select');
        if (!control || !header.contains(control)) return;
        const frame = header.getBoundingClientRect(), bounds = control.getBoundingClientRect();
        const left = frame.left + header.clientLeft + 8, right = frame.left + header.clientLeft + header.clientWidth - 8;
        if (bounds.left < left) header.scrollLeft -= left - bounds.left;
        else if (bounds.right > right) header.scrollLeft += bounds.right - right;
      }}><div className="office-floor-toolbar">
        <div className="office-background-toolbar" title={background.custom ? t('customBackground') : t('themeBackground', { theme: t(`themes.${currentTheme}`) })}>
          <Select<OfficeThemeId> size="small" virtual={false} listHeight={320} popupMatchSelectWidth={240} aria-label={t('sceneTheme')} value={currentTheme} options={OFFICE_THEME_IDS.map(value => ({ value, label: t(`themes.${value}`) }))} onChange={changeTheme} />
          <div className="office-background-actions"><Button size="small" className={background.custom ? 'has-custom-background' : undefined} aria-label={t('chooseBackground')} title={t('chooseBackground')} loading={background.busy} onClick={() => backgroundInput.current?.click()} icon={<svg aria-hidden="true" viewBox="0 0 20 20"><rect x="2.5" y="3" width="15" height="14" rx="2" /><circle cx="7" cy="7.5" r="1.3" /><path d="m3 15 4-4 3 2 3-5 4 7" /></svg>} /><Button size="small" aria-label={t('resetBackground')} title={t('resetBackground')} disabled={background.busy || !background.custom && !background.error} onClick={() => backgroundRef.current?.reset()} icon={<svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 7a6.5 6.5 0 1 1-.2 5M4 3v4h4" /></svg>} /></div>
          <input ref={backgroundInput} type="file" accept=".png,.jpg,.jpeg,.webp" aria-label={t('chooseBackground')} hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) backgroundRef.current?.import(file); }} />
        </div>
        <div className="office-floor-navigation">
          <Button size="small" aria-label={t('previous')} title={t('previous')} disabled={currentFloor === 0} onClick={() => setFloor(currentFloor - 1)}>‹</Button>
          <span className="office-floor-label">{t('floor', { current: currentFloor + 1, total: floors })}</span>
          <Button size="small" aria-label={t('next')} title={t('next')} disabled={currentFloor >= floors - 1} onClick={() => setFloor(currentFloor + 1)}>›</Button>
        </div>
        <div className="office-scene-actions"><div className="office-view-controls"><Button size="small" className="office-focus-button" aria-pressed={focusDesks} disabled={background.custom} onClick={() => setFocusDesks(value => !value)} title={t('focusHint')}>{t('focusDesks')}</Button><OfficeZoomControl zoom={zoom} onChange={setZoom} compact /></div>
        <OfficeEffectsControl value={marginEffects} error={marginEffectsError} onChange={changeMarginEffects} />
        <Button size="small" className="office-settings-trigger" aria-label={t('studioSettings')} title={t('studioSettings')} onClick={() => { setDiagnosticsOpen(false); setOfficeNameDraft(officeName); setSettingsOpen(true); }} icon={<svg aria-hidden="true" viewBox="0 0 20 20"><path d="m8 2-.5 2-2 .9-1.8-.6-2 3.4 1.4 1.5v2l-1.4 1.5 2 3.4 1.8-.6 2 .9.5 2h4l.5-2 2-.9 1.8.6 2-3.4-1.4-1.5v-2l1.4-1.5-2-3.4-1.8.6-2-.9-.5-2Z" /><circle cx="10" cy="10" r="2.7" /></svg>}><span className="office-settings-text">{t('studioSettings')}</span></Button>
        </div></div></header>
        {background.error ? <p className="office-background-error" role="alert">{t(background.error, { defaultValue: t('backgroundImageError') })}</p> : null}
        {themePreferences.error ? <p className="office-background-error" role="alert">{t('themeStorageError')}</p> : null}
        <div className="office-scene-stage">
          <div className="office-margin-effects" aria-hidden="true"><canvas className="office-margin-effect is-left" ref={marginLeftRef} width={1} height={1} /><canvas className="office-margin-effect is-right" ref={marginRightRef} width={1} height={1} /></div>
        <div ref={viewportRef} className="office-canvas-wrap"><div ref={surfaceRef} className="office-scene-surface" style={{ width: `${Math.max(1, Math.round(fitWidth * zoom / 100))}px` }}>{vectorTheme ? <OfficeVectorScene theme={vectorTheme} viewBox={viewBox} /> : null}<canvas ref={canvasRef} width={OFFICE_SCENE_WIDTH} height={height} style={{ aspectRatio: `${camera.width} / ${camera.height}` }} aria-label={t('title')}
          onPointerMove={event => {
            if (event.pointerType === 'touch') return;
            const bounds = event.currentTarget.getBoundingClientRect();
            const point = officeCameraPoint(paintedCameraRef.current ?? camera, event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height);
            inspectDesk(!stale ? hitTestOffice(hitsRef.current, point.x, point.y) : null, event.clientX, event.clientY);
          }} onPointerDown={dismissDesk} onPointerLeave={dismissDesk} onClick={event => {
          const bounds = event.currentTarget.getBoundingClientRect(); const point = officeCameraPoint(paintedCameraRef.current ?? camera, event.clientX - bounds.left, event.clientY - bounds.top, bounds.width, bounds.height); const hit = hitTestOffice(hitsRef.current, point.x, point.y); if (hit) selectSource(hit);
        }} />{vectorTheme ? <OfficeVectorScene theme={vectorTheme} viewBox={viewBox} foreground /> : null}<div ref={feedbackRootRef} className="office-feedback-layer" aria-hidden="true" />{!visible.length && !transitionPending ? <div className="office-scene-empty">{t(!snapshot ? 'syncPending' : seated.length ? 'noMatches' : 'noSessions')}</div> : null}</div></div>
        </div>
      </section><aside className="office-sidebar"><div className="office-list-heading"><h2>{t('sessionList')}</h2><span>{filtered.length} / {sources.length}</span></div>
        <div className="office-summary"><span>{t('running')} {sources.filter(source => source.phase === 'RUNNING' || source.phase === 'THINKING').length}</span><span>{t('waiting')} {sources.filter(source => source.phase === 'WAITING_USER').length}</span>
          <Popover content={t('sessionGesture')} trigger={['hover', 'focus', 'click']} placement="left">
            <button type="button" className="office-session-help" aria-label={t('sessionGesture')}><svg aria-hidden="true" focusable="false" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5M10 6v.5" /></svg></button>
          </Popover></div>
        <p id="office-session-hint" className="office-screen-reader-only">{t('sessionGesture')}</p>
        <div className="office-session-list" role="list" aria-label={t('sessionList')}>{filtered.map(source => <button key={source.sourceKey} className={`office-session ${selected === source.sourceKey ? 'is-selected' : ''}`} aria-pressed={selected === source.sourceKey} aria-describedby="office-session-hint" title={`${source.projectLabel} / ${source.tabLabel} · ${source.product} · ${source.provider}`} onClick={() => selectSource(source.sourceKey)} onDoubleClick={() => navigate(source, false)} onKeyDown={event => { if (event.key === 'Enter' && !event.repeat) { event.preventDefault(); selectSource(source.sourceKey); navigate(source, false); } }}>
          <span className="office-session-title"><strong>{source.projectLabel} / {source.tabLabel}</strong><span className="office-session-phase"><i style={{ background: phaseColor(source.phase) }} />{t(`phase.${source.phase}`)}</span></span>
          <span className="office-session-meta"><span>{source.product} · {source.provider}</span>{attention.has(source.sourceKey) ? <span className="office-attention-badge">{t('needsAttention')}</span> : null}</span></button>)}</div>
        <div className="office-selection" role="status"><div className="office-selection-heading"><strong>{t('selected')}</strong>{currentSource ? <span>{currentSource.product} · {currentSource.provider}</span> : null}</div>
          {currentSource ? <><div className="office-selection-details"><span title={`${currentSource.projectLabel} / ${currentSource.tabLabel}`}>{currentSource.projectLabel} / {currentSource.tabLabel}</span><span title={currentSource.modelLabel}>{currentSource.modelLabel || '—'}</span></div>{currentSource.phase === 'WAITING_USER' ? <p>{t(`waitReason.${currentSource.waitReason}`)} · {currentSource.pendingInteractionCount}</p> : null}
            {currentSource.pendingInteractionId && currentSource.phase === 'WAITING_USER' ? <div className="office-route-actions"><Button size="small" disabled={navPending || stale || currentSource.routeStatus !== 'AVAILABLE'} onClick={() => navigate(currentSource, true)}>{t('openInteraction')}</Button></div> : null}
            {sharedInitial ? <OfficeAppearanceControl value={appearanceOverrides[currentSource.sourceKey]} choices={petChoices} loading={choicesLoading} error={choicesError} disabled={stale || presentationPending} onChange={changeAppearance} onRefresh={() => { void loadPetChoices(); receiverRef.current?.resync(); poolRef.current?.retry(); }} /> : null}
            {currentSource.routeStatus !== 'AVAILABLE' ? <small>{t(`route.${currentSource.routeStatus}`)}</small> : null}</> : <p>{t('selectHint')}</p>}
          {navPending && pendingNavigation.current?.sourceKey === selected ? <p>{t('openingTab')}</p> : navigation ? <p>{t(`navigation.${navigation}`)}</p> : null}</div>
        <OfficeRecentResults results={snapshot?.scene.recentResults ?? []} sources={sources} product={product} search={search} stale={stale} pending={navPending} onOpen={source => { selectSource(source.sourceKey); navigate(source, false); }} />
      </aside></div>
      {preview && previewSource ? <OfficeDeskPreview source={previewSource} anchor={preview} /> : null}
      <OfficeSettings open={settingsOpen} onClose={() => setSettingsOpen(false)}
        officeName={{ value: officeName, draft: officeNameDraft, error: officeNamePreferences.error, valid: validOfficeName, onDraft: setOfficeNameDraft, onApply: applyOfficeName }}
        cache={{ limitMiB: cachePreferences.limitMiB, draft: cacheDraft, error: cachePreferences.error, busy: background.busy, onDraft: setCacheDraft, onApply: applyCacheLimit }}
        presentation={{ value: presentation, error: presentationError, reducedMotion, onChange: changePresentation }}
        shared={!!sharedInitial} recovered={!!window.__PET_OFFICE_BOOTSTRAP__?.preferencesRecovered} />
    </main>
  </ConfigProvider>;
}
