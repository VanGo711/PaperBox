import { ChevronDown, ChevronRight, Focus, Maximize2, Minus, Network, Plus, Search, X } from 'lucide-react';
import { type PointerEvent as ReactPointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import { paperCatalog } from '../data/paperCatalog';

interface RawConcept { 名称: string; 类型?: string; 别名?: string[]; 关系?: string; 说明?: string; 来源?: string[]; 子项?: RawConcept[]; }
interface PaperRecord {
  id: string; title: string; category: string; author?: string; researchArea?: string; tags?: string[]; abstract?: string; summary?: string;
  classification?: Record<string, string[]>; methodName?: string; methodAbbreviation?: string; venue?: string; year?: string;
  hierarchy?: { primaryResearchField?: string; secondaryResearchField?: string; coreTechnologies?: string[]; coreTechnology?: string };
  paperNodeName?: string;
}
interface ConceptNode {
  id: string; name: string; type: string; aliases: string[]; relation?: string; description?: string; sources: string[];
  children: ConceptNode[]; parentId?: string; path: string[]; depth: number; descendantCount: number; paper?: PaperRecord;
}
interface PositionedNode { node: ConceptNode; x: number; y: number; parentId?: string; }

const TYPE_CLASS: Record<string, string> = {
  '一级研究领域': 'system', '二级研究领域': 'equipment', '论文节点': 'paper', '核心技术': 'assembly',
};
function createNode(raw: RawConcept, parent: ConceptNode | undefined, depth: number, nextId: () => number): ConceptNode {
  const id = (parent?.id ?? 'root') + '-' + raw.名称 + '-' + nextId();
  const node: ConceptNode = {
    id, name: raw.名称, type: raw.类型 ?? '未分类', aliases: raw.别名 ?? [], relation: raw.关系,
    description: raw.说明, sources: raw.来源 ?? [], children: [], parentId: parent?.id,
    path: [...(parent?.path ?? []), raw.名称], depth, descendantCount: 0,
  };
  node.children = (raw.子项 ?? []).map((child) => createNode(child, node, depth + 1, nextId));
  node.descendantCount = node.children.reduce((total, child) => total + child.descendantCount + 1, 0);
  return node;
}

function paperHierarchy(papers: PaperRecord[]) {
  const rawRoots: RawConcept[] = [];
  const ensureChild = (nodes: RawConcept[], name: string, type: string, aliases: string[] = []) => {
    let node = nodes.find((item) => item.名称 === name);
    if (!node) {
      node = { 名称: name, 类型: type, 别名: aliases, 关系: '关联', 说明: '由已导入论文自动归类。', 来源: [], 子项: [] };
      nodes.push(node);
    }
    node.子项 ??= [];
    return node;
  };
  const inferredHierarchy = (paper: PaperRecord, classification: Record<string, string[]>) => {
    const evidence = [paper.title, paper.abstract, ...(paper.tags ?? []), ...(classification.topics ?? []), ...(classification.methods ?? []), paper.summary].filter(Boolean).join(' ').toLocaleLowerCase();
    const primary = /text[- ]?to[- ]?sql|text2sql|nl2sql|自然语言.*sql/.test(evidence) ? '数据库与自然语言交互' : '人工智能与数据管理';
    const secondary = /evaluation|评测|benchmark|基准|survey|综述|error analysis|误差分析/.test(evidence)
      ? 'Text-to-SQL 评测与分析'
      : /retrieval|检索|schema link|模式链接|schema-aware/.test(evidence)
        ? 'Text-to-SQL 模式链接与检索'
        : /agent|智能体|multi-agent|多智能体/.test(evidence)
          ? 'Text-to-SQL 智能体协作'
          : /monte carlo|mcts|tree search|树搜索|heuristic search|启发式搜索/.test(evidence)
            ? 'Text-to-SQL 推理与搜索'
            : 'Text-to-SQL 生成与解析';
    const coreTechnologies = [
      /multi[- ]?agent|多智能体|多 agent/.test(evidence) ? '多 Agent 协作' : '',
      /reinforcement learning|强化学习/.test(evidence) ? '强化学习' : '',
      /monte carlo|mcts|tree search|树搜索/.test(evidence) ? '蒙特卡洛树搜索' : '',
      /retrieval|检索|rag/.test(evidence) ? '检索增强' : '',
      /schema link|模式链接|relation-aware|关系感知/.test(evidence) ? '模式链接' : '',
      /execution feedback|执行反馈|self[- ]?feedback|自我反馈/.test(evidence) ? '执行反馈' : '',
      /prompt|提示/.test(evidence) ? '提示工程' : '',
    ].filter(Boolean);
    return { primary, secondary, coreTechnologies: coreTechnologies.length ? coreTechnologies : ['大语言模型推理'] };
  };
  const paperNodeName = (paper: PaperRecord) => {
    const named = paper.paperNodeName || paper.methodAbbreviation || (paper.methodName && paper.methodName !== '论文未提及' ? paper.methodName : '');
    if (named) return named.slice(0, 48);
    const title = paper.title.replace(/[:：].*$/, '').trim();
    return title.slice(0, /[\u4e00-\u9fff]/.test(title) ? 24 : 48);
  };
  for (const paper of papers) {
    const classification = paper.classification ?? {};
    const inferred = inferredHierarchy(paper, classification);
    const primary = paper.hierarchy?.primaryResearchField || inferred.primary;
    const secondary = paper.hierarchy?.secondaryResearchField || inferred.secondary;
    const primaryNode = ensureChild(rawRoots, primary, '一级研究领域');
    const secondaryNode = ensureChild(primaryNode.子项!, secondary, '二级研究领域');
    const paperNode = ensureChild(secondaryNode.子项!, paperNodeName(paper), '论文节点');
    paperNode.别名 = [];
    paperNode.说明 = paper.abstract || paper.summary || '论文处理完成后可查看具体信息。';
    paperNode.来源 = [paper.id];
    (paperNode as RawConcept & { 论文?: PaperRecord }).论文 = paper;
    const technologies = paper.hierarchy?.coreTechnologies?.filter(Boolean)
      ?? (paper.hierarchy?.coreTechnology ? [paper.hierarchy.coreTechnology] : inferred.coreTechnologies);
    for (const technology of technologies) {
      const technologyNode = ensureChild(paperNode.子项!, technology, '核心技术');
      technologyNode.来源 = [paper.id];
    }
  }
  let sequence = 0;
  const nextId = () => sequence++;
  const roots = rawRoots.map((node) => createNode(node, undefined, 0, nextId));
  const allNodes: ConceptNode[] = [];
  const nodeById = new Map<string, ConceptNode>();
  const collect = (node: ConceptNode, raw: RawConcept) => {
    const paper = (raw as RawConcept & { 论文?: PaperRecord }).论文;
    if (paper) node.paper = paper;
    allNodes.push(node);
    nodeById.set(node.id, node);
    node.children.forEach((child, index) => collect(child, (raw.子项 ?? [])[index]));
  };
  roots.forEach((node, index) => collect(node, rawRoots[index]));
  return { roots, allNodes, nodeById };
}

function hasSearchMatch(node: ConceptNode, keyword: string): boolean {
  if (!keyword) return true;
  const target = keyword.toLocaleLowerCase();
  return [node.name, node.type, ...node.aliases].some((value) => value.toLocaleLowerCase().includes(target)) || node.children.some((child) => hasSearchMatch(child, keyword));
}
function sourceText(source: string) {
  const matched = source.match(/^B\[(.+)]-C\[(.+)]-L\[(.+)]$/);
  return matched ? matched[1] + ' · ' + matched[2] + ' · 位置 ' + matched[3] : source;
}

function TreeNode({ node, selectedId, query, collapsedIds, onSelect, onToggle, onOpenDetail }: {
  node: ConceptNode; selectedId: string; query: string; collapsedIds: Set<string>;
  onSelect: (id: string) => void; onToggle: (id: string) => void; onOpenDetail: (id: string) => void;
}) {
  if (!hasSearchMatch(node, query)) return null;
  const hasChildren = node.children.length > 0;
  const collapsed = collapsedIds.has(node.id);
  return <li className="concept-tree-node">
    <div className={'concept-tree-row' + (node.id === selectedId ? ' active' : '')} style={{ paddingLeft: 11 + node.depth * 14 }}>
      {hasChildren ? <button className="concept-tree-toggle" aria-label={(collapsed ? '展开' : '收起') + node.name} onClick={() => onToggle(node.id)}>{collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}</button> : <span className="concept-tree-toggle-placeholder" />}
      <button className="concept-tree-label" title={node.name} onClick={() => onSelect(node.id)} onDoubleClick={() => node.paper && onOpenDetail(node.id)}><i className={'concept-type-dot ' + (TYPE_CLASS[node.type] ?? 'default')} /><span>{node.name}</span>{node.type !== '论文节点' && hasChildren && <small>{node.children.length}</small>}</button>
    </div>
    {hasChildren && !collapsed && <ul>{node.children.map((child) => <TreeNode key={child.id} node={child} selectedId={selectedId} query={query} collapsedIds={collapsedIds} onSelect={onSelect} onToggle={onToggle} onOpenDetail={onOpenDetail} />)}</ul>}
  </li>;
}

export function ConceptPage() {
  const [papers, setPapers] = useState<PaperRecord[]>(() => paperCatalog as PaperRecord[]);
  const { roots, allNodes, nodeById } = useMemo(() => paperHierarchy(papers), [papers]);
  const collapsedBelowFirstLevel = () => new Set(allNodes.filter((node) => node.children.length > 0 && node.depth >= 1).map((node) => node.id));
  const [query, setQuery] = useState('');
  const [selectedId, setSelectedId] = useState('');
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [treeCollapsed, setTreeCollapsed] = useState<Set<string>>(() => new Set());
  const [graphCollapsed, setGraphCollapsed] = useState<Set<string>>(() => new Set());
  const [graphOverview, setGraphOverview] = useState(false);
  const [browserWidth, setBrowserWidth] = useState(258);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [graphZoom, setGraphZoom] = useState(1);
  const [graphPan, setGraphPan] = useState({ x: 0, y: 0 });
  const graphScrollRef = useRef<HTMLDivElement>(null);
  const graphDraggedRef = useRef(false);
  const selectedNode = selectedId ? nodeById.get(selectedId) : undefined;
  const detailNode = detailId ? nodeById.get(detailId) : undefined;
  const categoryCount = useMemo(() => allNodes.filter((node) => node.type !== '论文节点').length, [allNodes]);

  useEffect(() => {
    let cancelled = false;
    const refreshPapers = () => fetch('/paper-api/catalog')
      .then(async (response) => {
        const payload = await response.json() as { papers?: PaperRecord[] };
        if (!response.ok) throw new Error();
        if (!cancelled) setPapers(payload.papers ?? []);
      })
      .catch(() => { /* The static hierarchy remains available when the local catalog is unavailable. */ });
    void refreshPapers();
    const timer = window.setInterval(() => { void refreshPapers(); }, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const positioned = useMemo(() => {
    const output: PositionedNode[] = [];
    const visibleRoots = focusedId && nodeById.has(focusedId) ? [nodeById.get(focusedId)!] : roots;
    let leafCursor = 0;
    const visit = (node: ConceptNode, depth: number, parentId?: string): number => {
      const visibleChildren = graphCollapsed.has(node.id) ? [] : node.children;
      const childY = visibleChildren.map((child) => visit(child, depth + 1, node.id));
      const y = childY.length
        ? childY.reduce((total, value) => total + value, 0) / childY.length
        : 24 + leafCursor++ * 42;
      output.push({ node, x: 22 + depth * 250, y, parentId });
      return y;
    };
    visibleRoots.forEach((node) => visit(node, 0));
    return output;
  }, [focusedId, graphCollapsed]);
  const positionsById = useMemo(() => new Map(positioned.map((item) => [item.node.id, item])), [positioned]);
  const graphWidth = Math.max(760, ...positioned.map((item) => item.x + 240));
  const graphHeight = Math.max(360, ...positioned.map((item) => item.y + 36), 0) + 24;
  const graphScale = graphOverview ? Math.min(1, 600 / graphHeight) : 1;
  const renderedGraphScale = graphScale * graphZoom;
  const matchingCount = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    return keyword ? allNodes.filter((node) => [node.name, node.type, ...node.aliases].some((value) => value.toLocaleLowerCase().includes(keyword))).length : allNodes.length;
  }, [query]);

  const catalogSignature = useMemo(() => papers.map((paper) => paper.id).sort().join('|'), [papers]);
  useEffect(() => {
    if (!roots.length) return;
    setSelectedId((current) => nodeById.has(current) ? current : roots[0].id);
    setFocusedId((current) => current && nodeById.has(current) ? current : null);
  }, [catalogSignature, nodeById, roots]);

  const selectNode = (id: string) => {
    setSelectedId(id);
    setGraphOverview(false);
    const ancestors = new Set<string>();
    let current = nodeById.get(id);
    while (current?.parentId) { ancestors.add(current.parentId); current = nodeById.get(current.parentId); }
    setTreeCollapsed((previous) => new Set([...previous].filter((item) => !ancestors.has(item))));
  };
  const openDetail = (id: string) => {
    selectNode(id);
    setDetailId(id);
  };
  const toggleSet = (setter: React.Dispatch<React.SetStateAction<Set<string>>>, id: string) => setter((previous) => {
    const next = new Set(previous);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const collapseToFirstLevel = () => {
    const collapsed = collapsedBelowFirstLevel();
    setTreeCollapsed(new Set(collapsed));
    setGraphCollapsed(collapsed);
    setGraphOverview(false);
  };
  const toggleFocus = () => {
    if (focusedId) {
      setFocusedId(null);
      return;
    }
    setGraphCollapsed((previous) => {
      const next = new Set(previous);
      next.delete(selectedId);
      return next;
    });
    setFocusedId(selectedId);
    setGraphOverview(false);
  };
  const showOverview = () => {
    setFocusedId(null);
    setGraphCollapsed(new Set());
    setGraphOverview(true);
    setGraphZoom(1);
    setGraphPan({ x: 0, y: 0 });
  };
  const expandAll = () => {
    setGraphCollapsed(new Set());
    setGraphOverview(false);
  };
  const beginBrowserResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = browserWidth;
    const move = (moveEvent: globalThis.PointerEvent) => {
      setBrowserWidth(Math.min(520, Math.max(220, startWidth + moveEvent.clientX - startX)));
    };
    const finish = () => {
      document.body.classList.remove('concept-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    document.body.classList.add('concept-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };
  const beginGraphPan = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const startPan = graphPan;
    graphDraggedRef.current = false;
    const move = (moveEvent: globalThis.PointerEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3) graphDraggedRef.current = true;
      setGraphPan({
        x: startPan.x + (moveEvent.clientX - startX) / renderedGraphScale,
        y: startPan.y + (moveEvent.clientY - startY) / renderedGraphScale,
      });
    };
    const finish = () => {
      document.body.classList.remove('concept-panning');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
    };
    document.body.classList.add('concept-panning');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish, { once: true });
  };
  useEffect(() => {
    const surface = graphScrollRef.current;
    if (!surface) return;
    const zoomGraph = (event: WheelEvent) => {
      if (!event.metaKey) return;
      event.preventDefault();
      setGraphOverview(false);
      setGraphZoom((current) => Math.min(2.4, Math.max(0.35, current * (event.deltaY < 0 ? 1.12 : 0.89))));
    };
    surface.addEventListener('wheel', zoomGraph, { passive: false });
    return () => surface.removeEventListener('wheel', zoomGraph);
  }, []);

  return <div className="concept-page" style={{ gridTemplateColumns: String(browserWidth) + 'px 10px minmax(0, 1fr)' }}>
    <aside className="concept-browser">
      <div className="concept-browser-heading"><div><Network size={17} /><strong>论文分类</strong></div><span>{categoryCount} 个分类 · {papers.length} 篇论文</span></div>
      <label className="concept-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索分类、类型或别名" />{query && <button onClick={() => setQuery('')} aria-label="清除搜索"><X size={14} /></button>}</label>
      {query && <div className="concept-search-count">匹配 {matchingCount} 个分类</div>}
      <div className="concept-tree"><ul>{roots.map((node) => <TreeNode key={node.id} node={node} selectedId={selectedId} query={query.trim()} collapsedIds={treeCollapsed} onSelect={selectNode} onToggle={(id) => toggleSet(setTreeCollapsed, id)} onOpenDetail={openDetail} />)}</ul></div>
    </aside>
    <div className="concept-resize-handle" role="separator" aria-orientation="vertical" aria-label="调整论文分类列表宽度" onPointerDown={beginBrowserResize} />
    <section className="concept-graph-panel">
      <header className="concept-graph-toolbar">
        <div className="concept-legend">{Object.entries(TYPE_CLASS).map(([type, typeClass]) => <span key={type}><i className={'concept-type-dot ' + typeClass} />{type}</span>)}</div>
        <div className="concept-graph-actions">
          <button onClick={expandAll} title="展开全部"><Plus size={16} /><span>展开</span></button>
          <button onClick={collapseToFirstLevel} title="收起至一级"><Minus size={16} /><span>收起</span></button>
          <button className={focusedId ? 'active' : ''} onClick={toggleFocus} disabled={!selectedId} title="聚焦所选分支"><Focus size={16} /><span>聚焦</span></button>
          <button onClick={showOverview} title="显示完整层级"><Maximize2 size={16} /><span>全图</span></button>
        </div>
      </header>
      <div ref={graphScrollRef} className={'concept-graph-scroll' + (graphOverview ? ' is-overview' : '')} onPointerDown={beginGraphPan}><svg className="concept-graph" width={graphWidth * renderedGraphScale} height={graphHeight * renderedGraphScale} viewBox={'0 0 ' + graphWidth + ' ' + graphHeight} role="img" aria-label="论文分类层级关系图">
        <g transform={'translate(' + graphPan.x + ' ' + graphPan.y + ')'}>
        <g className="concept-links">{positioned.map((item) => {
          if (!item.parentId) return null;
          const parent = positionsById.get(item.parentId);
          if (!parent) return null;
          const path = ['M', parent.x + 228, parent.y + 17, 'C', parent.x + 234, parent.y + 17 + ',', item.x - 10, item.y + 17 + ',', item.x, item.y + 17].join(' ');
          return <path key={item.node.id} d={path} />;
        })}</g>
        <g>{positioned.map(({ node, x, y }) => {
          const hasChildren = node.children.length > 0;
          const isCollapsed = graphCollapsed.has(node.id);
          return <g key={node.id} className={'concept-graph-node ' + (TYPE_CLASS[node.type] ?? 'default') + (node.id === selectedId ? ' selected' : '')} transform={'translate(' + x + ' ' + y + ')'} onClick={() => { if (!graphDraggedRef.current) selectNode(node.id); }} onDoubleClick={() => { if (!graphDraggedRef.current && node.paper) openDetail(node.id); }}>
            <defs><clipPath id={'concept-node-text-' + node.id}><rect x="23" y="3" width="174" height="28" /></clipPath></defs>
            <rect width="208" height="34" rx="5" /><circle cx="13" cy="17" r="4" /><text x="23" y="22" clipPath={'url(#concept-node-text-' + node.id + ')'}>{node.name}{node.type !== '论文节点' && node.children.length ? ` (${node.children.length})` : ''}</text>
            {hasChildren && <g className="concept-node-expander" transform="translate(220 17)" onClick={(event) => { event.stopPropagation(); setGraphOverview(false); toggleSet(setGraphCollapsed, node.id); }}><circle r="8" />{isCollapsed ? <path d="M -3 0 H 3 M 0 -3 V 3" /> : <path d="M -3 0 H 3" />}</g>}
          </g>;
        })}</g>
        </g>
      </svg></div>
    </section>
    {detailNode && <div className="concept-detail-modal-backdrop" role="presentation" onMouseDown={() => setDetailId(null)}>
      <aside className="concept-detail-modal" role="dialog" aria-modal="true" aria-labelledby="concept-detail-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="concept-detail-close" type="button" onClick={() => setDetailId(null)} aria-label="关闭详情"><X size={16} /></button>
      <div className="concept-detail-title"><span className={'concept-type-badge ' + (TYPE_CLASS[detailNode.type] ?? 'default')}>{detailNode.type}</span><h1 id="concept-detail-title">{detailNode.name}</h1>{detailNode.relation && <small>与上级：{detailNode.relation}</small>}</div>
      <div className="concept-detail-body">
        <p className="concept-path">{detailNode.path.map((item, index) => <span key={item + '-' + index}>{item}</span>)}</p>
        {detailNode.paper && <section className="concept-paper-details"><h2>论文信息</h2><dl><div><dt>论文</dt><dd>{detailNode.paper.title}</dd></div><div><dt>方法</dt><dd>{detailNode.paper.methodAbbreviation || detailNode.paper.methodName || '论文未提及'}</dd></div><div><dt>出版</dt><dd>{[detailNode.paper.venue, detailNode.paper.year].filter(Boolean).join(' · ') || '论文未提及'}</dd></div><div><dt>作者</dt><dd>{detailNode.paper.author || '论文未提及'}</dd></div></dl></section>}
        {detailNode.paper ? <>
          <section><h2>摘要</h2><p className="concept-description">{detailNode.paper.abstract || '论文未提取到摘要。'}</p></section>
          {detailNode.paper.summary && detailNode.paper.summary !== detailNode.paper.abstract && <section><h2>内容总结</h2><p className="concept-description">{detailNode.paper.summary}</p></section>}
        </> : <p className="concept-description">{detailNode.description ?? '当前分类尚未补充说明。'}</p>}
      </div>
      </aside>
    </div>}
  </div>;
}
