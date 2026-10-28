import { CircleAlert, KeyRound, RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { filterChatModels, knowledgeModelKey, readEnabledChatModelKeys, saveEnabledChatModelKeys } from '../knowledge/model-selection';

interface Platform { id: string; name: string; baseUrl: string; }
interface Model { id: string; name: string; capabilities?: string[]; modalities?: string[]; }
interface Quota { model: string; requestLimit?: number | null; requestUsed?: number | null; usageLimit?: number | null; usageUsed?: number | null; usageField?: string; }
interface LocalUsage { requests?: number; inputTokens?: number; outputTokens?: number; totalTokens?: number; lastUsedAt?: string; }
interface UsageSummary { models?: Record<string, LocalUsage>; updatedAt?: string | null; }
interface ModelSelection { persisted?: boolean; enabledModelIds?: string[]; }
interface CachedModels { models?: Model[]; quotas?: Quota[]; usage?: UsageSummary; selection?: ModelSelection; error?: string; }
interface TestState { status: 'testing' | 'success' | 'error'; detail: string; }

function quotaFor(model: Model, quotas: Quota[]) { return quotas.find((quota) => quota.model === model.id || quota.model === model.name); }
function QuotaMeter({ used, total, unit }: { used?: number | null; total?: number | null; unit: string }) {
  const hasTotal = typeof total === 'number' && total > 0;
  const hasUsed = typeof used === 'number' && used >= 0;
  const progress = hasTotal && hasUsed ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const totalLabel = total === null ? '未限制' : hasTotal ? `${total.toLocaleString()} ${unit}` : '—';
  const usedLabel = hasUsed ? `${used.toLocaleString()} ${unit}` : '未返回';
  return <span className={`quota-meter${hasUsed ? '' : ' is-unknown'}`}><span className="quota-meter-track"><i style={{ width: `${progress}%` }} /></span><small>{usedLabel} / {totalLabel}</small></span>;
}
function LocalUsageMeter({ value, unit, title }: { value?: number; unit: string; title: string }) {
  const amount = typeof value === 'number' ? value : 0;
  return <span className="quota-meter local-usage-meter" title={title}><span className="quota-meter-track"><i /></span><small>累计 {amount.toLocaleString()} {unit}</small></span>;
}

export function ModelsPage() {
  const [platform, setPlatform] = useState<Platform | null>(null);
  const [models, setModels] = useState<Model[]>([]);
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [usage, setUsage] = useState<Record<string, LocalUsage>>({});
  const [enabledModelKeys, setEnabledModelKeys] = useState(readEnabledChatModelKeys);
  const [syncing, setSyncing] = useState(false);
  const [loadingModels, setLoadingModels] = useState(true);
  const [error, setError] = useState('');
  const [testStates, setTestStates] = useState<Record<string, TestState>>({});
  const [testError, setTestError] = useState<{ model: string; detail: string } | null>(null);

  const loadPlatform = async () => {
    try {
      const response = await fetch('/model-api/platforms');
      const payload = await response.json() as { platforms?: Platform[]; error?: string };
      if (!response.ok) throw new Error(payload.error ?? '模型平台读取失败。');
      const nextPlatform = payload.platforms?.[0] ?? null;
      setPlatform(nextPlatform);
      if (!nextPlatform) setLoadingModels(false);
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '模型平台读取失败。'); setLoadingModels(false); }
  };
  const loadModels = async (platformId?: string) => {
    if (!platformId) return;
    setSyncing(true); setError('');
    try {
      const response = await fetch('/model-api/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platformId }) });
      const payload = await response.json() as CachedModels;
      if (!response.ok) throw new Error(payload.error ?? '模型同步失败。');
      const nextModels = filterChatModels(payload.models ?? []);
      const selectedIds = new Set(payload.selection?.enabledModelIds ?? nextModels.map((model) => model.id));
      const nextEnabled = nextModels.filter((model) => selectedIds.has(model.id)).map((model) => knowledgeModelKey(platformId, model.id));
      setModels(nextModels); setQuotas(payload.quotas ?? []); setUsage(payload.usage?.models ?? {}); setEnabledModelKeys(nextEnabled); saveEnabledChatModelKeys(nextEnabled); setTestStates({});
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '模型同步失败。'); }
    finally { setSyncing(false); setLoadingModels(false); }
  };
  useEffect(() => { void loadPlatform(); }, []);
  useEffect(() => { void loadModels(platform?.id); }, [platform?.id]);

  const syncModels = async () => {
    await loadModels(platform?.id);
  };
  const testModel = async (model: Model) => {
    if (!platform) return;
    setTestStates((current) => ({ ...current, [model.id]: { status: 'testing', detail: '请求中' } }));
    try {
      const response = await fetch('/model-api/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platformId: platform.id, model: model.id, modalities: model.modalities }) });
      const payload = await response.json() as { reply?: string; available?: boolean; localUsage?: LocalUsage; error?: string };
      if (!response.ok) throw new Error(payload.error ?? '测试请求失败。');
      const detail = payload.reply?.trim() || '未返回文本';
      if (!payload.available) throw new Error(`模型返回“${detail}”，未得到预期 pong。`);
      if (payload.localUsage) setUsage((current) => ({ ...current, [model.id]: payload.localUsage! }));
      setTestStates((current) => ({ ...current, [model.id]: { status: 'success', detail } }));
    } catch (requestError) {
      const detail = requestError instanceof Error ? requestError.message : '测试请求失败。';
      setTestStates((current) => ({ ...current, [model.id]: { status: 'error', detail } }));
      setTestError({ model: model.name, detail });
    }
  };
  const toggleChatModel = async (model: Model, checked: boolean) => {
    const key = knowledgeModelKey(platform?.id ?? '', model.id);
    const next = checked
      ? [...new Set([...enabledModelKeys, key])]
      : enabledModelKeys.filter((item) => item !== key);
    setEnabledModelKeys(next);
    if (!saveEnabledChatModelKeys(next)) setError('浏览器无法保存模型选择，本次勾选仅在当前页面有效。');
    if (!platform) return;
    try {
      const enabledModelIds = models.filter((item) => next.includes(knowledgeModelKey(platform.id, item.id))).map((item) => item.id);
      const response = await fetch('/model-api/selection', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ platformId: platform.id, enabledModelIds }) });
      const payload = await response.json() as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? '模型选择保存失败。');
    } catch (requestError) { setError(requestError instanceof Error ? requestError.message : '模型选择保存失败。'); }
  };

  return <main className="model-selection-page">
    <header className="model-selection-toolbar"><strong>模型选择</strong><span className="temporary-key-label" title={platform?.baseUrl}><KeyRound size={15} />{platform?.name ?? 'Qwen 环境变量平台'}</span><div className="model-selection-actions"><button type="button" title="刷新模型与额度" aria-label="刷新模型与额度" disabled={!platform || syncing} onClick={syncModels}><RefreshCw className={syncing ? 'spin' : ''} size={17} /></button></div></header>
    {error && <div className="model-selection-error"><CircleAlert size={15} />{error}</div>}
    {models.length > 0 && <section className="model-selection-list" aria-label="模型列表"><div className="model-selection-list-head"><span>模型名</span><span>能力</span><span>本系统请求</span><span>本系统 Token</span><span>测试</span><span>选择</span></div>{models.map((model) => {
      const quota = quotaFor(model, quotas); const test = testStates[model.id];
      const localUsage = usage[model.id];
      const requestLimit = typeof quota?.requestLimit === 'number' ? `；当前限流上限 ${quota.requestLimit.toLocaleString()} 次` : '';
      const tokenLimit = typeof quota?.usageLimit === 'number' ? `；当前限流上限 ${quota.usageLimit.toLocaleString()} Tokens` : '';
      const key = knowledgeModelKey(platform?.id ?? '', model.id);
      return <div key={model.id} className="model-selection-row"><span className="model-selection-name"><strong>{model.name}</strong></span><span className="model-capabilities">{model.capabilities?.join(' · ') || '—'}</span><LocalUsageMeter value={localUsage?.requests} unit="次" title={`本系统成功调用累计${requestLimit}`} /><LocalUsageMeter value={localUsage?.totalTokens} unit="Tokens" title={`本系统成功调用累计（输入 ${localUsage?.inputTokens ?? 0} / 输出 ${localUsage?.outputTokens ?? 0}）${tokenLimit}`} /><span className="model-test-cell"><button type="button" disabled={test?.status === 'testing'} onClick={() => { void testModel(model); }}>{test?.status === 'testing' ? '测试中…' : '测试'}</button>{test && test.status !== 'testing' && <small className={test.status}>{test.status === 'success' ? '可用 · pong' : '失败'}</small>}</span><span className="model-selection-choice"><input type="checkbox" checked={enabledModelKeys.includes(key)} onChange={(event) => { void toggleChatModel(model, event.target.checked); }} aria-label={`在知识问答中使用 ${model.name}`} /></span></div>;
    })}</section>}
    {loadingModels && <div className="model-selection-empty">正在读取模型…</div>}
    {!loadingModels && !models.length && !error && <div className="model-selection-empty">没有符合条件的文本生成模型。</div>}
    {testError && <div className="model-modal-backdrop" role="presentation" onMouseDown={() => setTestError(null)}><section className="model-modal model-test-error-modal" role="alertdialog" aria-modal="true" aria-label="模型测试失败" onMouseDown={(event) => event.stopPropagation()}><button type="button" className="model-modal-close" onClick={() => setTestError(null)}><X size={17} /></button><CircleAlert size={21} /><h2>{testError.model} 测试失败</h2><p>{testError.detail}</p><button type="button" className="model-test-button" onClick={() => setTestError(null)}>知道了</button></section></div>}
  </main>;
}
