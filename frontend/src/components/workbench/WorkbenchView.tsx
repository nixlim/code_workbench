import ReactFlow, { Background, Controls, Handle, Position, addEdge, useEdgesState, useNodesState, type Connection, type NodeProps } from 'reactflow';
import { useEffect, useMemo, useState } from 'react';
import type { ModuleRecord } from '../../api/generated/types';
import { api } from '../../api/client';

type Port = { name: string; type: string; required?: boolean };
type ModuleNodeData = { label: string; module: ModuleRecord };

export function WorkbenchView({ onError }: { onError: (value: string) => void }) {
  const [palette, setPalette] = useState<ModuleRecord[]>([]);
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selected, setSelected] = useState<ModuleRecord | null>(null);
  const [validation, setValidation] = useState('not_run');
  const [blueprintId, setBlueprintId] = useState('');
  const nodeTypes = useMemo(() => ({ moduleNode: ModuleNode }), []);

  useEffect(() => { api.list<ModuleRecord>('/api/workbench/palette').then((r) => setPalette(r.items)).catch((e) => onError(e.message)); }, []);

  const addModule = (mod: ModuleRecord) => {
    setSelected(mod);
    setNodes((current) => [...current, { id: `${mod.id}-${current.length}`, type: 'moduleNode', position: { x: 120 + current.length * 80, y: 120 }, data: { label: `${mod.name}@${mod.version}`, module: mod } }]);
  };

  const onConnect = async (connection: Connection) => {
    const source = nodes.find((node) => node.id === connection.source)?.data.module as ModuleRecord | undefined;
    const target = nodes.find((node) => node.id === connection.target)?.data.module as ModuleRecord | undefined;
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
    <section className="workbench">
      <header className="page-header"><h2>Workbench</h2><span>{validation}</span><button onClick={save}>Save</button><button onClick={() => validate().catch((e) => onError(e.message))}>Validate</button><button onClick={() => blueprintId && api.post(`/api/blueprints/${blueprintId}/wiring-jobs`).catch((e) => onError(e.message))}>Generate Code</button></header>
      <div className="workbench-grid">
        <aside className="palette">{palette.map((m) => <button key={m.id} onClick={() => addModule(m)}><strong>{m.name}</strong><span>{m.version}</span></button>)}</aside>
        <div className="canvas"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={(connection) => onConnect(connection).catch((e) => onError(e.message))} fitView><Background /><Controls /></ReactFlow></div>
        <aside className="inspector">{selected ? <><h3>{selected.name}</h3><pre>{JSON.stringify(selected.portsJson, null, 2)}</pre></> : <span>Select a module</span>}</aside>
      </div>
    </section>
  );
}

function ModuleNode({ data }: NodeProps<ModuleNodeData>) {
  const inputs = getPorts(data.module, 'inputs');
  const outputs = getPorts(data.module, 'outputs');
  return (
    <div className="module-node">
      <strong>{data.label}</strong>
      <div className="module-node-ports">
        <div>{inputs.map((port, index) => <PortRow key={port.name} port={port} type="target" index={index} total={inputs.length} />)}</div>
        <div>{outputs.map((port, index) => <PortRow key={port.name} port={port} type="source" index={index} total={outputs.length} />)}</div>
      </div>
    </div>
  );
}

function PortRow({ port, type, index, total }: { port: Port; type: 'source' | 'target'; index: number; total: number }) {
  const top = `${((index + 1) / (total + 1)) * 100}%`;
  return <span className={`port-row ${type}`}><Handle id={port.name} type={type} position={type === 'source' ? Position.Right : Position.Left} style={{ top }} />{port.name}<em>{port.type}{port.required ? ' required' : ''}</em></span>;
}

function findPort(mod: ModuleRecord | undefined, direction: 'inputs' | 'outputs', name: string | null | undefined) {
  return getPorts(mod, direction).find((port) => port.name === name);
}

function getPorts(mod: ModuleRecord | undefined, direction: 'inputs' | 'outputs'): Port[] {
  const ports = mod?.portsJson as { inputs?: Port[]; outputs?: Port[] } | undefined;
  return ports?.[direction] ?? [];
}
