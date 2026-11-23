// Board B: @xyflow/react 13 — every frame is a node (DOM) with a live iframe or a thumbnail.
// Nodes are not draggable, so dragging a node pans; wheel pans, ctrl+wheel and two fingers zoom.
import { memo, useEffect, useMemo, useRef } from 'react'
import { Background, BackgroundVariant, ReactFlow, ReactFlowProvider, useReactFlow } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { FrameBox, LABEL, params, useOpen } from './shared.jsx'

const FrameNode = memo(function FrameNode({ data }) {
  return <FrameBox f={data.f} live={data.live} />
})
const nodeTypes = { frame: FrameNode }
const noop = () => {}

function Inner({ layout, live, onReady, onSettle }) {
  const rf = useReactFlow()
  const open = useOpen()
  const wrap = useRef(null)
  const nodes = useMemo(() => layout.frames.map((f) => ({
    id: f.id, type: 'frame', position: { x: f.x, y: f.y }, data: { f, live: live.has(f.id) },
    width: f.w, height: f.h, draggable: false, selectable: false, connectable: false, focusable: false,
  })), [layout, live])
  useEffect(() => {
    onReady({
      getViewport: () => rf.getViewport(),
      setViewport: (v) => { rf.setViewport(v, { duration: 0 }); onSettle?.(v) },
      element: wrap.current,
    })
  }, [rf])
  return (
    <div ref={wrap} className={`board board-b pe-${params.pe}`}>
      <ReactFlow
        nodes={nodes} edges={[]} nodeTypes={nodeTypes}
        panOnDrag panOnScroll panOnScrollSpeed={0.5} zoomOnPinch zoomOnScroll={false} zoomOnDoubleClick={false}
        minZoom={0.02} maxZoom={2} nodesDraggable={false} nodesConnectable={false} elementsSelectable={false}
        defaultViewport={{ x: 0, y: 0, zoom: 0.1 }}
        onMoveStart={() => wrap.current?.classList.add('moving')}
        onMoveEnd={(_, v) => { wrap.current?.classList.remove('moving'); onSettle?.(v) }}
        onNodeClick={noop /* without a click handler @xyflow/react gives a node pointer-events: none, and a double click never reaches it */}
        onNodeDoubleClick={(_, n) => open(n.id)}
      >
        {params.bg && <Background variant={BackgroundVariant.Dots} gap={24} size={2} color="#c9ced6" />}
      </ReactFlow>
    </div>
  )
}

export default function BoardB(props) {
  return <ReactFlowProvider><Inner {...props} /></ReactFlowProvider>
}
export { LABEL }
