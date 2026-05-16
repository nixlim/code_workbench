import ReactFlow, { Background, Controls, Handle, Position, addEdge, useEdgesState, useNodesState, type Connection, type NodeProps } from 'reactflow';
import { LayoutDashboard, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { ModuleRecord } from '../../api/generated/types';
import { api } from '../../api/client';
import { Button } from '../ui/button';
import { Badge } from '../ui/badge';
import { Card, CardHeader, CardTitle, CardContent } from '../ui/card';
import { cn } from '../../lib/utils';

type Port = { name: string; type: string; required?: boolean };
type ModuleNodeData = { label: string; module: ModuleRecord };

const validationVariant = (status: string) => status === 'valid' ? 'success' : status === 'invalid' ? 'danger' : 'default';

export function WorkbenchView({ onError }: { onError: (value: string) => void }) {
  const [palette, setPalette] = useState<ModuleRecord[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState<ModuleNodeData>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selected, setSelected] = useState<ModuleRecord | null>(null);
  const [validation, setValidation] = useState('not_run');
  const [blueprintId, setBlueprintId] = useState('');
  const nodeTypes = useMemo(() => ({ moduleNode: ModuleNode }), []);

  const loadPalette = () => api.list<ModuleRecord>('/api/workbench/palette').then((r) => setPalette(r.items)).catch((e) => onError(e.message));
  useEffect(() => { void loadPalette(); }, []);

  const addModule = (mod: ModuleRecord) => {
    setSelected(mod);
    setNodes((current) => [...current, { id: `${mod.id}-${current.length}`, type: 'moduleNode', position: { x: 120 + current.length * 80, y: 120 }, data: { label: `${mod.name}@${mod.version}`, module: mod } }]);
  };

  const onConnect = async (connection: Connection) => {
    const source = nodes.find((node) => node.id === connection.source)?.data.module;
    const target = nodes.find((node) => node.id === connection.target)?.data.module;
    const sourcePort = findPort(source, 'outputs', connection.sourceHandle);
    const targetPort = findPort(target, 'inputs', connection.targetHandle);
    if (!source || !target || !sourcePort || !targetPort) {
      onError('Incompatible ports cannot be connected.');
      return;
    }
    await api.post('/api/workbench/validate-edge', { sourceModuleId: source.id, sourcePort: sourcePort.name, targetModuleId: target.id, targetPort: targetPort.name });
    setEdges((current) => addEdge({ ...connection, data: { sourcePort: sourcePort.name, targetPort: targetPort.name } }, current));
  };

  const save = async () => {
    const semanticDocument = {
      nodes: nodes.map((n) => ({ id: n.id, moduleId: n.data.module?.id, config: {} })),
      edges: edges.map((e) => ({ id: e.id, sourceNodeId: e.source, sourcePort: e.data?.sourcePort, targetNodeId: e.target, targetPort: e.data?.targetPort }))
    };
    const flowLayout = { nodes, edges, viewport: {} };
    const saved = await api.post<{ id: string; validationStatus: string }>('/api/blueprints', { name: 'Workbench Blueprint', semanticDocument, flowLayout, targetLanguage: 'go', outputKind: 'service', packageName: 'main' });
    setBlueprintId(saved.id);
    setValidation(saved.validationStatus);
    return saved.id;
  };

  const validate = async () => {
    const id = blueprintId || await save();
    if (!id) return;
    const result = await api.post<{ validationStatus: string }>(`/api/blueprints/${id}/validate`);
    setValidation(result.validationStatus);
  };

  return (
    <section className="space-y-4">
      <header className="flex items-center justify-between pb-1">
        <h2 className="text-lg font-semibold text-gray-900 m-0">Workbench</h2>
        <div className="flex items-center gap-2">
          <Badge variant={validationVariant(validation)}>{validation}</Badge>
          <Button onClick={() => save().catch((e) => onError(e.message))}>Save</Button>
          <Button onClick={() => validate().catch((e) => onError(e.message))}>Validate</Button>
          <Button variant="primary" disabled={!blueprintId} onClick={() => blueprintId && api.post(`/api/blueprints/${blueprintId}/wiring-jobs`).catch((e) => onError(e.message))}>Generate code</Button>
          <Button variant="ghost" size="icon" aria-label="Refresh palette" onClick={() => void loadPalette()}>
            <RefreshCw size={14} />
          </Button>
        </div>
      </header>
      <Card>
        <CardHeader>
          <LayoutDashboard size={16} className="text-accent-fg" />
          <CardTitle>Wire modules into a blueprint</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <div className="grid grid-cols-[200px_1fr_240px] h-[min(580px,calc(100vh-240px))] min-h-[420px]">
            <aside className="border-r border-border-subtle p-3 overflow-auto space-y-1">
              {palette.map((m) => (
                <button
                  key={m.id}
                  className="flex items-center gap-2 w-full px-2.5 py-2 rounded-md text-left text-sm border-none bg-transparent hover:bg-surface-secondary transition-colors cursor-pointer"
                  onClick={() => addModule(m)}
                >
                  <span className="font-medium text-gray-900 truncate">{m.name}</span>
                  <span className="text-xs text-gray-400 ml-auto">{m.version}</span>
                </button>
              ))}
              {palette.length === 0 && <p className="text-sm text-gray-400 py-3 text-center m-0">No modules in the palette yet.</p>}
            </aside>
            <div className="relative" aria-label="Workbench canvas">
              <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(connection) => onConnect(connection).catch((e) => onError(e.message))} onNodeClick={(_, node) => setSelected(node.data.module)} fitView>
                <Background />
                <Controls />
              </ReactFlow>
            </div>
            <aside className="border-l border-border-subtle p-3 overflow-auto">
              {selected ? (
                <div className="space-y-2">
                  <h4 className="text-sm font-semibold text-gray-900 m-0">{selected.name}</h4>
                  <pre className="text-xs font-mono text-gray-600 whitespace-pre-wrap overflow-wrap-anywhere bg-surface-secondary rounded p-2 m-0">{JSON.stringify(selected.portsJson, null, 2)}</pre>
                </div>
              ) : (
                <p className="text-sm text-gray-400 m-0">Select a module to inspect</p>
              )}
            </aside>
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

function ModuleNode({ data }: NodeProps<ModuleNodeData>) {
  const inputs = getPorts(data.module, 'inputs');
  const outputs = getPorts(data.module, 'outputs');
  return (
    <div className="min-w-[200px] bg-surface border border-border-default rounded-lg p-3 shadow-md">
      <strong className="block text-xs font-semibold text-gray-900 mb-2">{data.label}</strong>
      <div className="grid grid-cols-2 gap-3">
        <div>{inputs.map((port, index) => <PortRow key={port.name} port={port} type="target" index={index} total={inputs.length} />)}</div>
        <div>{outputs.map((port, index) => <PortRow key={port.name} port={port} type="source" index={index} total={outputs.length} />)}</div>
      </div>
    </div>
  );
}

function PortRow({ port, type, index, total }: { port: Port; type: 'source' | 'target'; index: number; total: number }) {
  const top = `${((index + 1) / (total + 1)) * 100}%`;
  return (
    <span className={cn('relative grid gap-0.5 min-h-[24px] text-xs text-gray-700', type === 'source' && 'text-right')}>
      <Handle id={port.name} type={type} position={type === 'source' ? Position.Right : Position.Left} style={{ top }} />
      {port.name}
      <em className="not-italic text-gray-400 text-[10px]">{port.type}{port.required ? ' required' : ''}</em>
    </span>
  );
}

function findPort(mod: ModuleRecord | undefined, direction: 'inputs' | 'outputs', name: string | null | undefined) {
  return getPorts(mod, direction).find((port) => port.name === name);
}

function getPorts(mod: ModuleRecord | undefined, direction: 'inputs' | 'outputs'): Port[] {
  const raw = mod?.portsJson;
  const ports = typeof raw === 'string' ? safeJSON<{ inputs?: Port[]; outputs?: Port[] }>(raw) : raw as { inputs?: Port[]; outputs?: Port[] } | undefined;
  return ports?.[direction] ?? [];
}

function safeJSON<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}
