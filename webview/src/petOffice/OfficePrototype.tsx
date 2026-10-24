import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from 'antd/es/button';
import Input from 'antd/es/input';
import Select from 'antd/es/select';
import ConfigProvider from 'antd/es/config-provider';
import { theme } from 'antd';
import { useTranslation } from 'react-i18next';
import { createOfficeFixtures, filterOfficeSources, OFFICE_FIXTURE_COUNTS, OFFICE_FLOOR_CAPACITY, officeFloorSources, phaseColor } from './officeModel';
import type { OfficeFixtureCount, OfficeProduct } from './officeModel';
import { OfficeAnimationClock } from './officeAnimation';
import { drawOfficeScene, hitTestOffice, OFFICE_SCENE_HEIGHT, OFFICE_SCENE_WIDTH } from './officeRenderer';
import type { OfficeHitRegion } from './officeRenderer';
import { BUILTIN_OFFICE_ASSET, createOfficeSheetFixture, loadOfficeImage, officeAssetVisual } from './officeAssets';
import type { OfficeAsset } from './officeAssets';
import { sendOfficeCommand } from './officeBridge';
import { OFFICE_THEME_IDS } from './officeThemes';
import type { OfficeThemeId } from './officeThemes';

/** The G0 scene intentionally has no chat contexts or real-session adapters. */
export function OfficePrototype() {
  const { t } = useTranslation('petOffice');
  const [count, setCount] = useState<OfficeFixtureCount>(10);
  const [product, setProduct] = useState<OfficeProduct | 'all'>('all');
  const [search, setSearch] = useState('');
  const [floor, setFloor] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [nativeVisible, setNativeVisible] = useState(() => !window.petOfficeNativeBridge);
  const [asset, setAsset] = useState<OfficeAsset>(BUILTIN_OFFICE_ASSET);
  const [assetError, setAssetError] = useState<string | null>(null);
  const [assetLoading, setAssetLoading] = useState(false);
  const [sceneTheme, setSceneTheme] = useState<OfficeThemeId>('loft');
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const statsRef = useRef<HTMLSpanElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const clockRef = useRef<OfficeAnimationClock | null>(null);
  const hitsRef = useRef<OfficeHitRegion[]>([]);
  const assetRef = useRef(asset);
  const loadRef = useRef<AbortController | null>(null);
  const pendingLoadRef = useRef<Promise<void>>(Promise.resolve());
  const sources = useMemo(() => createOfficeFixtures(count), [count]);
  const filtered = useMemo(() => filterOfficeSources(sources, product, search), [sources, product, search]);
  const floors = Math.max(1, Math.ceil(count / OFFICE_FLOOR_CAPACITY));
  const currentFloor = Math.min(floor, floors - 1);
  const visible = useMemo(() => officeFloorSources(filtered, currentFloor), [filtered, currentFloor]);
  const currentSource = sources.find(source => source.sourceKey === selected);
  const sceneRef = useRef({ visible, selected, visual: officeAssetVisual(asset), theme: sceneTheme });
  const nativeRef = useRef(nativeVisible);
  nativeRef.current = nativeVisible;
  sceneRef.current = { visible, selected, visual: officeAssetVisual(assetRef.current), theme: sceneTheme };

  const paint = useCallback((time: number) => {
    const canvas = canvasRef.current;
    if (canvas) hitsRef.current = drawOfficeScene(canvas, sceneRef.current.visible, sceneRef.current.selected, time, sceneRef.current.visual, undefined, sceneRef.current.theme);
  }, []);

  useEffect(() => {
    const clock = new OfficeAnimationClock(paint, undefined, metrics => {
      if (statsRef.current) statsRef.current.textContent = `${metrics.fps.toFixed(1)} FPS · ${metrics.drawMs.toFixed(2)} ms`;
      if (nativeRef.current) sendOfficeCommand('metrics', { ...metrics, visibleSources: sceneRef.current.visible.length, decodedBytes: assetRef.current.decodedBytes });
    });
    clockRef.current = clock;
    const diagnostics = () => ({ ...clock.getMetrics(), sourceCount: sources.length, visibleSources: sceneRef.current.visible.length, decodedBytes: assetRef.current.decodedBytes, assetKind: assetRef.current.kind, nativeVisible: nativeRef.current, simulated: true });
    // Updated below as fixtures change, while clock and browser stay singletons.
    window.petOfficeDiagnostics = diagnostics;
    window.petOfficeSetVisible = visibleState => setNativeVisible(visibleState);
    sendOfficeCommand('ready');
    return () => {
      clock.dispose(); clockRef.current = null;
      delete window.petOfficeDiagnostics; delete window.petOfficeSetVisible;
      loadRef.current?.abort(); loadRef.current = null; assetRef.current.release();
    };
  }, [paint]);

  useEffect(() => {
    window.petOfficeDiagnostics = () => ({ ...clockRef.current?.getMetrics(), sourceCount: sources.length, visibleSources: visible.length, decodedBytes: assetRef.current.decodedBytes, assetKind: assetRef.current.kind, nativeVisible, simulated: true });
  }, [sources.length, visible.length, nativeVisible]);

  useEffect(() => {
    const updateActivity = () => {
      const active = nativeVisible && document.visibilityState === 'visible' && !paused && visible.length > 0;
      clockRef.current?.setActive(active);
      if (nativeVisible && document.visibilityState === 'visible') paint(performance.now());
    };
    updateActivity();
    document.addEventListener('visibilitychange', updateActivity);
    return () => { document.removeEventListener('visibilitychange', updateActivity); clockRef.current?.setActive(false); };
  }, [nativeVisible, paused, visible.length, paint]);

  useEffect(() => {
    if (nativeVisible && document.visibilityState === 'visible') paint(performance.now());
  }, [visible, selected, asset, sceneTheme, nativeVisible, paint]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resize = () => {
      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = Math.max(1, Math.round(canvas.clientWidth * ratio));
      const height = Math.max(1, Math.round(canvas.clientHeight * ratio));
      if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
      if (nativeRef.current && document.visibilityState === 'visible') paint(performance.now());
    };
    const observer = new ResizeObserver(resize);
    observer.observe(canvas); window.addEventListener('resize', resize); resize();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [paint]);

  const replaceAsset = (next: OfficeAsset) => {
    const old = assetRef.current;
    assetRef.current = next;
    sceneRef.current.visual = officeAssetVisual(next);
    setAsset(next); setAssetError(null); old.release();
  };
  const loadImage = async (file: File) => {
    loadRef.current?.abort();
    const controller = new AbortController(); loadRef.current = controller;
    const previous = pendingLoadRef.current;
    // Retire old frames before decoding a replacement to bound peak memory.
    replaceAsset(BUILTIN_OFFICE_ASSET); setAssetLoading(true);
    const task = (async () => {
      try {
        // Native bitmap creation cannot be cancelled; wait before allocating again.
        await previous;
        controller.signal.throwIfAborted();
        const next = await loadOfficeImage(file, controller.signal);
        if (controller.signal.aborted) next.release();
        else replaceAsset(next);
      } catch (error) {
        if (!controller.signal.aborted) setAssetError(error instanceof Error && ['imageTooLarge', 'invalidImage', 'decodeBudget', 'animationUnavailable'].includes(error.message) ? error.message : 'imageError');
      } finally { if (loadRef.current === controller) setAssetLoading(false); }
    })();
    pendingLoadRef.current = task;
    await task;
  };
  const showSheetFixture = () => {
    loadRef.current?.abort();
    replaceAsset(BUILTIN_OFFICE_ASSET);
    try {
      replaceAsset(createOfficeSheetFixture());
    } catch {
      setAssetError('imageError');
    }
  };
  const selectSource = (key: string) => {
    const source = sources.find(item => item.sourceKey === key);
    if (source) { setSelected(key); setFloor(Math.floor(source.seat / OFFICE_FLOOR_CAPACITY)); }
  };

  return (
    <ConfigProvider theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: '#a8baff', colorBgContainer: '#222c41', colorBorder: '#3d4963', borderRadius: 9, fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif' } }}>
      <main className="pet-office">
        <header className="office-header">
          <div className="office-brand"><span className="office-brand-icon" aria-hidden="true">▣</span><div><h1>{t('title')}</h1><p>{t('subtitle')}</p></div></div>
          <div className="office-header-actions">
            <span className="office-prototype-badge">{t('prototype')}</span>
            <div className="office-scene-actions"><Button aria-pressed={paused} onClick={() => setPaused(value => !value)}>{t(paused ? 'resume' : 'pause')}</Button></div>
            {window.petOfficeNativeBridge ? <div className="office-native-actions"><Button onClick={() => sendOfficeCommand('hide')}>{t('hide')}</Button><Button onClick={() => sendOfficeCommand('exit')}>{t('exit')}</Button></div> : null}
          </div>
        </header>
        <p className="office-notice" role="note">{t('notice')}</p>
        <section className="office-toolbar" aria-label={t('sources')}>
          <label>{t('sources')}<Select aria-label={t('sources')} value={count} options={OFFICE_FIXTURE_COUNTS.map(value => ({ value, label: String(value) }))} onChange={value => { setCount(value); setFloor(0); setSelected(null); }} /></label>
          <Select aria-label={t('allProducts')} value={product} onChange={setProduct} options={['all', 'IDEA', 'PyCharm', 'WebStorm'].map(value => ({ value, label: value === 'all' ? t('allProducts') : value }))} />
          <Input.Search aria-label={t('search')} placeholder={t('search')} value={search} onChange={event => setSearch(event.target.value)} allowClear />
        </section>
        <div className="office-workspace">
          <section className="office-scene-panel" aria-label={t('title')}>
            <div className="office-floor-toolbar"><span>{t('floor', { current: currentFloor + 1, total: floors })}</span><div><Button size="small" disabled={currentFloor === 0} onClick={() => setFloor(currentFloor - 1)}>{t('previous')}</Button><Button size="small" disabled={currentFloor >= floors - 1} onClick={() => setFloor(currentFloor + 1)}>{t('next')}</Button></div></div>
            <div className="office-background-toolbar"><Select<OfficeThemeId> size="small" aria-label={t('sceneTheme')} value={sceneTheme} options={OFFICE_THEME_IDS.map(value => ({ value, label: t(`themes.${value}`) }))} onChange={setSceneTheme} /></div>
            <div className="office-canvas-wrap"><canvas ref={canvasRef} aria-label={t('title')} onClick={event => {
              const rect = event.currentTarget.getBoundingClientRect();
              const key = hitTestOffice(hitsRef.current, (event.clientX - rect.left) / rect.width * OFFICE_SCENE_WIDTH, (event.clientY - rect.top) / rect.height * OFFICE_SCENE_HEIGHT);
              if (key) selectSource(key);
            }} />{visible.length === 0 ? <div className="office-scene-empty">{t(count === 0 ? 'noSessions' : 'noMatches')}</div> : null}</div>
            <div className="office-asset-toolbar"><Button disabled={assetLoading} onClick={showSheetFixture}>{t('sheetFixture')}</Button><Button loading={assetLoading} onClick={() => fileRef.current?.click()}>{t('image')}</Button><Button disabled={asset.kind === 'builtin' || assetLoading} onClick={() => replaceAsset(BUILTIN_OFFICE_ASSET)}>{t('resetImage')}</Button><span>{asset.kind === 'builtin' ? t('builtin') : asset.name === 'sheetFixture' ? t('sheetFixture') : asset.name}</span>
              <input ref={fileRef} type="file" accept=".png,.jpg,.jpeg,.gif,.webp" aria-label={t('image')} hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void loadImage(file); }} /></div>
            <p className="office-preview-hint">{assetError ? <span role="alert">{t(assetError)}</span> : t('previewOnly')}</p>
            <footer className="office-diagnostics"><span>{t('render')}</span><span ref={statsRef}>0.0 FPS · 0.00 ms</span><span>{t('visible')} {visible.length}</span><span>{t('decoded')} {(asset.decodedBytes / 1024 / 1024).toFixed(1)} MiB</span></footer>
          </section>
          <aside className="office-sidebar"><div className="office-list-heading"><h2>{t('sessionList')}</h2><span>{filtered.length} / {count}</span></div>
            <div className="office-summary"><span><i style={{ background: '#7bc3d4' }} />{t('running')} {sources.filter(source => source.phase === 'RUNNING' || source.phase === 'THINKING').length}</span><span><i style={{ background: '#e8b866' }} />{t('waiting')} {sources.filter(source => source.phase === 'WAITING_USER').length}</span></div>
            <div className="office-session-list" role="list" aria-label={t('sessionList')}>{filtered.map(source => <button key={source.sourceKey} className={`office-session ${selected === source.sourceKey ? 'is-selected' : ''}`} aria-pressed={selected === source.sourceKey} onClick={() => selectSource(source.sourceKey)}><span className="office-session-product">{source.product}<span>{source.provider}</span></span><strong>{source.projectLabel} / {source.tabLabel}</strong><span className="office-session-phase"><i style={{ background: phaseColor(source.phase) }} />{t(`phase.${source.phase}`)}</span></button>)}</div>
            <div className="office-selection" role="status"><strong>{t('selected')}</strong><p>{currentSource ? `${currentSource.product} · ${currentSource.projectLabel} / ${currentSource.tabLabel}` : t('selectHint')}</p>{currentSource ? <small>{t('simulationHint')}</small> : null}</div>
          </aside>
        </div>
      </main>
    </ConfigProvider>
  );
}
