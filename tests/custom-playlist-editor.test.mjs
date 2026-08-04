import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { setupFoundryMocks, setMockSetting, createMockPlaylist, createMockSound } from './mocks/foundry.mjs';

setupFoundryMocks();

import { CustomPlaylistEditor } from '../scripts/custom-playlist-editor.mjs';
import { createEmptyGraph } from '../scripts/custom-playback-schema.mjs';

/**
 * A minimal fake of Drawflow's public surface, enough to drive
 * CustomPlaylistEditor's mounting/event-wiring logic without a real DOM or
 * the vendored library. Event listeners are stored so tests can fire them
 * manually (e.g. simulating Drawflow's own 'nodeSelected' dispatch, which is
 * exactly what the dragging regression this file guards against depends on).
 */
/**
 * The attribute half of a fake element. Every marker this editor puts on a PORT
 * or a CONNECTION is an attribute rather than a class (graph-decorations.mjs) -
 * a fake that only modelled classList could not see them at all.
 */
function fakeAttributes() {
  const attrs = new Map();
  return {
    attrs,
    setAttribute: (name, value) => attrs.set(name, String(value)),
    removeAttribute: (name) => attrs.delete(name),
    hasAttribute: (name) => attrs.has(name),
    getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null)
  };
}

function createFakeDrawflowClass() {
  return class FakeDrawflow {
    constructor(container) {
      this.container = container;
      this.reroute = false;
      this._listeners = {};
      this._nodeIdCounter = 0;
      this._nodes = {};
      // Drawflow's own public-ish surface that group dragging writes through:
      // the live node registry (same object identity as _nodes, so position
      // writes show up in export()), the current module name, and the zoom the
      // pointer delta is divided by.
      this.module = 'Home';
      this.drawflow = { drawflow: { Home: { data: this._nodes } } };
      this.zoom = 1;
      this.node_selected = null;
      this.zoomInCalls = 0;
      this.zoomOutCalls = 0;
      this.zoomResetCalls = 0;

      // _refreshNodeDisplay() queries `#node-<id> .drawflow_content_node` (the
      // inner content) and bare `#node-<id>` (the outer node box, for setting
      // the Fork/Random bar-shape height) on the live Drawflow instance's own
      // container, the same way it would in a real DOM. Fake both lookups
      // with id -> {innerHTML}/{style} maps so tests can assert on what got
      // rendered without a real browser.
      this._nodeElements = new Map();
      this._nodeOuterElements = new Map();
      // Output port elements (`.outputs .output.output_N` inside a node), which
      // the inspector's exit-row hover highlights.
      this._portElements = new Map();
      this._drainElements = new Map();
      container.querySelector = (sel) => {
        const portMatch = /^#node-(.+) \.outputs \.output\.(output_\d+)$/.exec(sel);
        if (portMatch) {
          const key = `${portMatch[1]}:${portMatch[2]}`;
          if (!this._portElements.has(key)) {
            const classes = new Set();
            const props = new Map();
            this._portElements.set(key, {
              // An exit's chip is written INTO its port element, because only
              // the port knows where it sits (outputs are in Drawflow's normal
              // flow) - see _refreshExitChips.
              innerHTML: '',
              ...fakeAttributes(),
              classList: {
                add: (...c) => c.forEach((x) => classes.add(x)),
                remove: (...c) => c.forEach((x) => classes.delete(x)),
                contains: (c) => classes.has(c)
              },
              style: {
                setProperty: (name, value) => props.set(name, value),
                getPropertyValue: (name) => props.get(name) ?? ''
              }
            });
          }
          return this._portElements.get(key);
        }
        // Input port elements. Hovering a wire reveals the port at BOTH of its
        // ends, so unlike the exit-row hover these have to be findable too -
        // and they must be matched before the bare `#node-<id>` fallback
        // below, whose greedy `(.+)` would otherwise swallow the whole
        // selector and hand back a node element.
        const inPortMatch = /^#node-(.+) \.inputs \.input\.(input_\d+)$/.exec(sel);
        if (inPortMatch) {
          const key = `${inPortMatch[1]}:${inPortMatch[2]}`;
          if (!this._portElements.has(key)) {
            const classes = new Set();
            this._portElements.set(key, {
              ...fakeAttributes(),
              classList: {
                add: (...c) => c.forEach((x) => classes.add(x)),
                remove: (...c) => c.forEach((x) => classes.delete(x)),
                contains: (c) => classes.has(c)
              }
            });
          }
          return this._portElements.get(key);
        }
        // The drain overlay's animated level element (Delay and Track).
        const drainMatch = /^#node-(.+) \.game-orchestra-node-fill-level$/.exec(sel);
        if (drainMatch) {
          if (!this._drainElements.has(drainMatch[1])) this._drainElements.set(drainMatch[1], { style: { animation: '' } });
          return this._drainElements.get(drainMatch[1]);
        }
        const contentMatch = /^#node-(.+) \.drawflow_content_node$/.exec(sel);
        if (contentMatch) {
          const nodeId = contentMatch[1];
          if (!this._nodeElements.has(nodeId)) this._nodeElements.set(nodeId, { innerHTML: '' });
          return this._nodeElements.get(nodeId);
        }
        const outerMatch = /^#node-(.+)$/.exec(sel);
        if (outerMatch) {
          const nodeId = outerMatch[1];
          if (!this._nodeOuterElements.has(nodeId)) {
            const classes = new Set();
            const style = {};
            const children = [];
            const el = {
              id: `node-${nodeId}`,
              style,
              offsetHeight: 64,
              offsetWidth: 130,
              // Validation badges are appended to the node element itself
              // (never to its content, which _refreshNodeDisplay replaces).
              children,
              appendChild(child) {
                children.push(child);
                child.parentElement = this;
                return child;
              },
              querySelector: (sel) => children.find((c) => String(c.className || '').includes(sel.replace('.', ''))) || null,
              // Group dragging reads offsetLeft/Top back after writing style.left/top
              // each frame (as Drawflow's own drag does), so the two must agree.
              get offsetLeft() {
                return parseFloat(style.left) || 0;
              },
              get offsetTop() {
                return parseFloat(style.top) || 0;
              },
              classList: {
                add: (...c) => c.forEach((x) => classes.add(x)),
                remove: (...c) => c.forEach((x) => classes.delete(x)),
                contains: (c) => classes.has(c)
              },
              closest: (sel) => (sel === '.drawflow-node' ? el : null),
              // Rect-select tests override this per node to place it inside/outside a drag rectangle.
              getBoundingClientRect: () => ({ left: 0, right: 0, top: 0, bottom: 0 })
            };
            this._nodeOuterElements.set(nodeId, el);
          }
          return this._nodeOuterElements.get(nodeId);
        }
        return null;
      };
      // _onCanvasMouseDown checks the click landed inside the canvas at all.
      container.contains = () => true;

      // _styleSelfLoopConnections() queries connection wrapper elements by
      // Drawflow's own class-naming convention. Fake connections are
      // registered via addFakeConnectionPath() below; each carries a fake
      // <path class="main-path"> whose 'd' attribute tests can read back to
      // verify the self-loop arc got applied.
      this._connectionElements = [];
      container.querySelectorAll = (sel) => {
        // A bare attribute selector: clearMarkers() sweeps every wire already
        // carrying a marker before reapplying it, so this has to actually find
        // them or the clear-and-reapply pass would be untested.
        const attr = /^\[([\w-]+)\]$/.exec(sel);
        if (attr) return this._connectionElements.filter((c) => c.el.hasAttribute(attr[1])).map((c) => c.el);
        const bare = /^\.([\w-]+)$/.exec(sel);
        if (bare) return this._connectionElements.filter((c) => c.el.classList.contains(bare[1])).map((c) => c.el);
        // Every part of the selector is optional, matching edgeSelector(): the
        // activity highlight names both endpoints plus the port, while the
        // exit-row hover names only the source node and its port.
        const m = /^\.connection(?:\.node_in_node-([^.]+))?(?:\.node_out_node-([^.]+))?(?:\.(output_\d+))?$/.exec(sel);
        if (!m) return [];
        const [, inId, outId, port] = m;
        return this._connectionElements
          .filter((c) => (!inId || c.inId === inId) && (!outId || c.outId === outId) && (!port || !c.port || c.port === port))
          .map((c) => c.el);
      };
    }
    /** Test helper: register a fake rendered connection between two node ids. */
    addFakeConnectionPath(outId, inId, initialD, port = null, inPort = 'input_1') {
      const pathEl = {
        _d: initialD,
        getAttribute(name) {
          return name === 'd' ? this._d : null;
        },
        setAttribute(name, value) {
          if (name === 'd') this._d = value;
        }
      };
      // The endpoint classes Drawflow itself writes onto every completed
      // connection. Real, not decorative: connectionPortSelectors() reads a
      // hovered wire's own class list to work out which two ports to reveal,
      // so a fake without them couldn't exercise that path at all.
      // Order matters as much as membership: the vendor writes them
      // node_in, node_out, output_N, input_N and then reads them back BY INDEX
      // (classList[3]/[4]) - see updateConnectionNodes() below.
      const classes = new Set(['connection', `node_in_node-${inId}`, `node_out_node-${outId}`]);
      if (port) classes.add(port);
      classes.add(inPort);
      const el = {
        ...fakeAttributes(),
        classList: {
          add: (...c) => c.forEach((x) => classes.add(x)),
          remove: (...c) => c.forEach((x) => classes.delete(x)),
          contains: (c) => classes.has(c),
          [Symbol.iterator]: () => classes[Symbol.iterator]()
        },
        querySelector: (sel) => (sel === '.main-path' ? pathEl : null),
        closest: (sel) => (sel === '.connection' ? el : null)
      };
      this._connectionElements.push({ outId, inId, port, inPort, el, pathEl });
      return pathEl;
    }
    start() {}
    import(data) {
      this.imported = data;
      // Real Drawflow's import() hydrates its internal node registry from the
      // imported data (that's the whole point of round-tripping) - mirror
      // that here so getNodeFromId()/addNodeOutput() etc. work on nodes that
      // came from the initial graph (e.g. the default 'start' node), not just
      // ones added afterward via addNode().
      this._nodes = JSON.parse(JSON.stringify(data?.drawflow?.Home?.data || {}));
      this.drawflow.drawflow.Home.data = this._nodes; // keep the live registry pointing at the new node set
      const numericIds = Object.keys(this._nodes).map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n));
      if (numericIds.length > 0) this._nodeIdCounter = Math.max(this._nodeIdCounter, ...numericIds);
    }
    /**
     * Real Drawflow's export() is `JSON.parse(JSON.stringify(this.drawflow))` - a DEEP CLONE,
     * not a live view. Undo snapshots (graph-history.mjs) are exactly that return value and are
     * held across later edits, so a fake returning the live registry would hand every snapshot
     * an alias of the state it is supposed to preserve.
     */
    export() {
      return JSON.parse(JSON.stringify({ drawflow: { Home: { data: this._nodes } } }));
    }
    on(event, cb) {
      (this._listeners[event] ||= []).push(cb);
    }
    _fire(event, ...args) {
      (this._listeners[event] || []).forEach((cb) => cb(...args));
    }
    addNode(name, inputs, outputs, x, y, cls, data, html) {
      const id = String(++this._nodeIdCounter);
      const inputsObj = {};
      for (let i = 1; i <= inputs; i++) inputsObj[`input_${i}`] = { connections: [] };
      const outputsObj = {};
      for (let i = 1; i <= outputs; i++) outputsObj[`output_${i}`] = { connections: [] };
      this._nodes[id] = { id, name, data, class: cls, html, typenode: false, inputs: inputsObj, outputs: outputsObj, pos_x: x, pos_y: y };
      return id;
    }
    getNodeFromId(id) {
      return JSON.parse(JSON.stringify(this._nodes[id]));
    }
    updateNodeDataFromId(id, data) {
      this._nodes[id].data = data;
    }
    addNodeOutput(id) {
      const node = this._nodes[id];
      const count = Object.keys(node.outputs).length;
      node.outputs[`output_${count + 1}`] = { connections: [] };
    }
    /**
     * Mirrors the vendored removeNodeOutput in the three ways the editor depends
     * on, all read out of drawflow.min.js and confirmed against it in a real DOM:
     * the port's own connections go first (each dispatching 'connectionRemoved'),
     * the remaining ports renumber contiguously (H5), and each surviving wire's
     * port classes are renumbered by REMOVE-then-ADD - which moves them to the
     * END of that wire's class list. That last one is why every marker this
     * editor puts on a wire is an attribute (graph-decorations.mjs); a fake that
     * just deleted the key could never show it.
     */
    removeNodeOutput(id, port) {
      const node = this._nodes[id];
      if (!node?.outputs?.[port]) return;
      const indexOf = (name) => parseInt(String(name).split('_')[1], 10);
      const removedIndex = indexOf(port);
      for (const conn of [...node.outputs[port].connections]) {
        this.removeSingleConnection(id, conn.node, port, conn.output);
        this._fire('connectionRemoved', { output_id: id, input_id: conn.node, output_class: port, input_class: conn.output });
      }
      delete node.outputs[port];
      const renumbered = {};
      Object.keys(node.outputs)
        .sort((a, b) => indexOf(a) - indexOf(b))
        .forEach((name, i) => {
          renumbered[`output_${i + 1}`] = node.outputs[name];
        });
      node.outputs = renumbered;
      // The mirrored input-side records name the SOURCE's output port, so they
      // shift with it.
      for (const other of Object.values(this._nodes)) {
        for (const inPort of Object.values(other.inputs || {})) {
          for (const conn of inPort.connections) {
            if (conn.node === String(id) && indexOf(conn.input) > removedIndex) conn.input = `output_${indexOf(conn.input) - 1}`;
          }
        }
      }
      for (const conn of this._connectionElements) {
        if (conn.outId !== String(id) || !conn.port || indexOf(conn.port) <= removedIndex) continue;
        const next = `output_${indexOf(conn.port) - 1}`;
        conn.el.classList.remove(conn.port);
        conn.el.classList.remove(conn.inPort);
        conn.el.classList.add(next);
        conn.el.classList.add(conn.inPort);
        conn.port = next;
      }
      this.updateConnectionNodes(`node-${id}`);
    }
    /**
     * Mirrors real Drawflow: takes the DOM id ('node-<n>'), not the bare numeric id, drops every
     * connection touching the node in either direction, and dispatches 'nodeRemoved' with the
     * NUMERIC id. The id form matters - a caller passing the bare number here silently removes
     * nothing, which is exactly the class of bug _deleteMultiSelection() has to get right.
     */
    removeNodeId(domId) {
      const id = String(domId).slice(5);
      if (!this._nodes[id]) return;
      for (const other of Object.values(this._nodes)) {
        for (const port of Object.values(other.outputs || {})) {
          port.connections = port.connections.filter((c) => c.node !== id);
        }
        for (const port of Object.values(other.inputs || {})) {
          port.connections = port.connections.filter((c) => c.node !== id);
        }
      }
      delete this._nodes[id];
      this._fire('nodeRemoved', id);
    }
    /**
     * Drawflow's mirrored connection model: recorded once under the source's
     * output and once under the target's input. On an outgoing connection the
     * field named `output` holds the TARGET's input port (its own naming).
     */
    addConnection(outId, inId, outputClass, inputClass) {
      this._nodes[outId].outputs[outputClass].connections.push({ node: String(inId), output: inputClass });
      this._nodes[inId].inputs[inputClass].connections.push({ node: String(outId), input: outputClass });
    }
    removeSingleConnection(outId, inId, outputClass, inputClass) {
      const outs = this._nodes[outId].outputs[outputClass].connections;
      const outIndex = outs.findIndex((c) => c.node === String(inId) && c.output === inputClass);
      if (outIndex >= 0) outs.splice(outIndex, 1);
      const ins = this._nodes[inId].inputs[inputClass].connections;
      const inIndex = ins.findIndex((c) => c.node === String(outId) && c.input === outputClass);
      if (inIndex >= 0) ins.splice(inIndex, 1);
    }
    /**
     * Records the call (several tests assert on it) AND enforces the vendor's
     * positional read of a wire's endpoint classes: it resolves the two ports as
     * classList[3]/classList[4] and immediately reads `.offsetWidth` off what
     * they select, so anything of ours sitting at those indices makes it
     * dereference undefined. That throw is not invented for this fake - it is
     * what deleting a Random exit did in a real DOM while our uncertain-edge
     * marker was still a class, aborting the delete half-done.
     */
    updateConnectionNodes(nodeElementId) {
      this.updateConnectionNodesCalls = this.updateConnectionNodesCalls || [];
      this.updateConnectionNodesCalls.push(nodeElementId);
      const id = String(nodeElementId).slice(5);
      for (const conn of this._connectionElements) {
        if (!conn.port || (conn.outId !== id && conn.inId !== id)) continue;
        const classes = [...conn.el.classList];
        if (!/^output_\d+$/.test(classes[3] ?? '') || !/^input_\d+$/.test(classes[4] ?? '')) {
          throw new TypeError("Cannot read properties of undefined (reading 'offsetWidth')");
        }
      }
    }
    zoom_in() {
      this.zoomInCalls++;
    }
    zoom_out() {
      this.zoomOutCalls++;
    }
    zoom_reset() {
      this.zoomResetCalls++;
    }
  };
}

/** A minimal fake of this.element sufficient for _mountDrawflow()/_renderInspector(). */
/**
 * A minimal fake of a `.game-orchestra-pane` section: enough classList/dataset/querySelector surface
 * for _setPaneCollapsed()/handleTogglePane (custom-playlist-editor.mjs) to toggle it and read its
 * collapsed state back, without a real DOM.
 */
function createFakePane(paneId, collapsed = false) {
  const classes = new Set(collapsed ? ['game-orchestra-collapsed'] : []);
  const header = { _ariaExpanded: null, setAttribute: (name, value) => (header[`_${name.replace(/-(\w)/g, (_, c) => c.toUpperCase())}`] = value) };
  const pane = {
    dataset: { pane: paneId },
    header,
    classList: {
      contains: (c) => classes.has(c),
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, force) => (force === undefined ? (classes.has(c) ? classes.delete(c) : classes.add(c)) : force ? classes.add(c) : classes.delete(c))
    },
    querySelector: (sel) => (sel === '.game-orchestra-pane-header' ? header : null),
    // Mirrors handleTogglePane's own lookup path: the header button's target.closest('.game-orchestra-pane').
    closest: (sel) => (sel === '.game-orchestra-pane' ? pane : null)
  };
  return pane;
}

function createFakeElement() {
  const canvas = { innerHTML: '', clientWidth: 500, clientHeight: 400 };
  // The styled wrapper AROUND the Drawflow mount point - a separate element in
  // the real template (the mount must own its own classList). _applyZoomTier()
  // stamps data-zoom-tier here.
  const drawflowCanvas = { dataset: {} };
  const inspector = { innerHTML: '' };
  // The Tracks pane body, modelled with the one behaviour that actually matters here: assigning
  // innerHTML DESTROYS the `[data-vg-drag]` rows inside it and creates new ones. That is what
  // orphans the dragstart handlers Foundry's (non-delegated) DragDrop#bind attached to the old
  // rows, and it is the whole reason _renderTracks() has to rebind - see its comment.
  const tracks = {
    _html: '',
    rows: [],
    get innerHTML() {
      return this._html;
    },
    set innerHTML(value) {
      this._html = value;
      const count = (value.match(/data-vg-drag/g) || []).length;
      this.rows = Array.from({ length: count }, (_, i) => ({ id: `row-${i}`, addEventListener: vi.fn() }));
    },
    // MixerController renders this pane now and binds its delegated listeners on the container.
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    querySelector: () => null
  };
  const validation = { innerHTML: '', style: {} };
  // The canvas toolbar's Undo/Redo buttons, whose `disabled` property is written directly by
  // _updateHistoryButtons() (never through a re-render - HR-A).
  const undoButton = { disabled: true };
  const redoButton = { disabled: true };
  // Mirrors the template's three panes. Only one starts expanded (properties) - the panel is a
  // single-open accordion, so a fake with several open at once could never occur live.
  const panes = {
    palette: createFakePane('palette', true),
    properties: createFakePane('properties', false),
    tracks: createFakePane('tracks', true)
  };
  return {
    canvas,
    drawflowCanvas,
    inspector,
    tracks,
    validation,
    panes,
    undoButton,
    redoButton,
    querySelector: (sel) => {
      if (sel === '[data-action="undo"]') return undoButton;
      if (sel === '[data-action="redo"]') return redoButton;
      if (sel === '[data-drawflow-mount]') return canvas;
      if (sel === '.game-orchestra-drawflow-canvas') return drawflowCanvas;
      if (sel === '.game-orchestra-editor-inspector') return inspector;
      if (sel === '.game-orchestra-editor-tracks') return tracks;
      if (sel === '.game-orchestra-editor-validation') return validation;
      const paneMatch = /^\.game-orchestra-pane\[data-pane="(\w+)"\]$/.exec(sel);
      if (paneMatch) return panes[paneMatch[1]] || null;
      return null;
    },
    // _setPaneCollapsed() reads the sibling list from the DOM so a pane added to the template is
    // folded into the accordion automatically - that lookup has to resolve here too, or expanding
    // one pane would silently stop collapsing the others.
    querySelectorAll: (sel) => {
      if (sel === '.game-orchestra-pane') return Object.values(panes);
      if (sel === '[data-vg-drag]') return tracks.rows;
      return [];
    },
    // _onKeyDown's focus guard calls this - a fake element contains nothing.
    contains: () => false,
    // Only needed by tests that drive the full _onRender()/_onClose() lifecycle
    // (the delegated change/mousedown listeners); nothing dispatches through them.
    addEventListener: vi.fn(),
    removeEventListener: vi.fn()
  };
}

describe('CustomPlaylistEditor', () => {
  beforeEach(() => {
    setupFoundryMocks();
  });

  describe('constructor', () => {
    it('starts with an empty skeleton graph when the playlist has no existing customPlayback flag', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      expect(editor.graph).toEqual(createEmptyGraph());
    });

    it('loads a deep clone of an existing customPlayback graph, independent of the stored flag', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const stored = { version: 1, nodes: [{ id: 'start', type: 'start' }], edges: [] };
      playlist.setFlag('game-orchestra', 'customPlayback', stored);

      const editor = new CustomPlaylistEditor(playlist);
      expect(editor.graph).toEqual(stored);

      editor.graph.nodes.push({ id: 'extra', type: 'end' });
      expect(stored.nodes).toHaveLength(1); // mutating the editor's copy must not affect the stored flag
    });

    it('starts with no node selected', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      expect(editor.selectedNodeId).toBeNull();
    });
  });

  describe('_prepareContext', () => {
    it('reports hasExistingGraph based on the playlist flag, independent of the in-memory working copy', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      expect(editor._prepareContext({}).hasExistingGraph).toBe(false);

      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [], edges: [] });
      expect(editor._prepareContext({}).hasExistingGraph).toBe(true);
    });

    it('builds soundOptions from the playlist sounds', () => {
      const s1 = createMockSound('s1', 'Track One');
      const s2 = createMockSound('s2', 'Track Two');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1, s2]);
      const editor = new CustomPlaylistEditor(playlist);

      const ctx = editor._prepareContext({});
      expect(ctx.soundOptions).toEqual([
        { id: 's1', name: 'Track One', selected: false },
        { id: 's2', name: 'Track Two', selected: false }
      ]);
    });

    it('includes validation results for the current working graph', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      // Empty skeleton graph (Start with no exit) is invalid until a real flow is built.
      const ctx = editor._prepareContext({});
      expect(ctx.validation.valid).toBe(false);
    });

    it('resolves selectedNode and selectedExits when a Random node is selected', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.graph = {
        version: 1,
        nodes: [{ id: 'r1', type: 'random' }, { id: 'a', type: 'end' }],
        edges: [{ id: 'e1', from: 'r1', to: 'a', weight: 2, cooldown: 1 }]
      };
      editor.selectedNodeId = 'r1';

      const ctx = editor._prepareContext({});
      expect(ctx.selectedNode.id).toBe('r1');
      expect(ctx.selectedExits).toEqual([{ id: 'e1', from: 'r1', to: 'a', weight: 2, cooldown: 1, portName: 'output_1' }]);
    });

    it('resolves selectedNode and selectedExits (with raw condition data) when a Condition node is selected', () => {
      // Building kindOptions for the dropdown is buildInspectorHtml's job now
      // (custom-playlist-inspector.mjs), not _prepareContext's - see its own tests.
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.graph = {
        version: 1,
        nodes: [{ id: 'c1', type: 'condition' }, { id: 'a', type: 'end' }],
        edges: [{ id: 'e1', from: 'c1', to: 'a', condition: { kind: 'mood', value: 'boss' } }]
      };
      editor.selectedNodeId = 'c1';

      const ctx = editor._prepareContext({});
      expect(ctx.selectedExits).toEqual([{ id: 'e1', from: 'c1', to: 'a', condition: { kind: 'mood', value: 'boss' }, portName: 'output_1' }]);
    });

    it('returns no selectedExits for a Track node (only Random/Condition carry per-exit metadata)', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.graph = { version: 1, nodes: [{ id: 't1', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }], edges: [] };
      editor.selectedNodeId = 't1';

      const ctx = editor._prepareContext({});
      expect(ctx.selectedExits).toEqual([]);
    });

    it('no longer reports a crossfade at all - that field moved to the mixer, which opens for every playlist type', () => {
      setMockSetting('game-orchestra', 'graphCrossfade', 150);
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.graph.crossfadeMs = 300;

      const ctx = editor._prepareContext({});
      expect(ctx.crossfadeMs).toBeUndefined();
      expect(ctx.worldCrossfadeMs).toBeUndefined();
    });
  });

  describe('legacy graph crossfade (still carried, never written from here)', () => {
    it('the Mixer pane replaces the crossfade field, and can still open the full window', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);

      // The compact pane drops columns that do not fit 300px, so the escape hatch to the
      // standalone window is part of the design, not a leftover.
      expect(CustomPlaylistEditor.DEFAULT_OPTIONS.actions.openMixer).toBe(CustomPlaylistEditor.handleOpenMixer);
      // The change-action route is gone entirely - a second place to set the same value is
      // exactly what moving it was meant to avoid.
      expect(CustomPlaylistEditor._CHANGE_ACTIONS.updateGraphCrossfade).toBeUndefined();
      expect(CustomPlaylistEditor.handleUpdateGraphCrossfade).toBeUndefined();
      expect(editor._syncCrossfadeInput).toBeUndefined();
    });

    it("survives a full Drawflow re-sync (regression: a graph-level field with no Drawflow representation would otherwise be silently dropped by drawflowExportToGraph's plain {version, nodes, edges} rebuild)", () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Track 1')]));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      editor.graph.crossfadeMs = 250;

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });

      expect(editor.graph.crossfadeMs).toBe(250);
      delete global.Drawflow;
    });

    it('survives being saved (the field is part of the same working graph object handleSave persists)', async () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.graph = {
        version: 1,
        nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }],
        edges: [{ id: 'e1', from: 'start', to: 'end' }],
        crossfadeMs: 275
      };
      editor.close = vi.fn();

      await CustomPlaylistEditor.handleSave.call(editor, { preventDefault: vi.fn() });

      expect(playlist.setFlag).toHaveBeenCalledWith('game-orchestra', 'customPlayback', expect.objectContaining({ crossfadeMs: 275 }));
    });

    it('survives applying a preset (which resyncs and replaces the graph body, but not this out-of-band field)', async () => {
      global.Drawflow = createFakeDrawflowClass();
      const sounds = [createMockSound('s1', 'Track 1'), createMockSound('s2', 'Track 2')];
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', sounds));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      editor.graph.crossfadeMs = 100;

      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, { value: 'shuffle', dataset: { changeAction: 'applyPreset' } });

      expect(editor.graph.crossfadeMs).toBe(100);
      delete global.Drawflow;
    });
  });

  describe('the Tracks pane (track list + mixer, merged)', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function mountedEditor(sounds = [createMockSound('s1', 'Track 1')]) {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', sounds);
      // MixerController re-reads the playlist from game.playlists on every access rather than
      // caching the document (it can be deleted out from under an open window), so the world
      // has to be able to find it - as it can in a live game.
      game.playlists.get = vi.fn((id) => (id === 'pl1' ? playlist : null));
      for (const sound of sounds) sound.parent = Object.assign(sound.parent, { getFlag: playlist.getFlag, sounds: playlist.sounds });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      return editor;
    }

    it('renders into its own container on mount', () => {
      const editor = mountedEditor();
      expect(editor.element.tracks.innerHTML).toContain('game-orchestra-mixer-row');
    });

    it('keeps both jobs in one pane: every row is a canvas drag source with an add-node button, alongside its volume', () => {
      const editor = mountedEditor();
      const html = editor.element.tracks.innerHTML;

      expect(html).toContain('data-vg-drag');
      expect(html).toContain('data-drag-type="PlaylistSound"');
      expect(html).toContain('data-action="addTrackNode"');
      expect(html).toContain('data-mix-action="trackVolume"');
    });

    it('counts Track nodes against the WORKING graph, so a node added a second ago is already counted', () => {
      const editor = mountedEditor();
      expect(editor.element.tracks.innerHTML).toContain('game-orchestra-mixer-unplaced');

      editor._addNodeOfType('track', { soundId: 's1' });

      // Nothing has been saved to the playlist flag at this point - counting against that would
      // leave the badge stale until Save.
      expect(editor.element.tracks.innerHTML).toContain('×1');
    });

    it('runs compact, with its keyboard shortcuts off - arrows, M and S belong to the canvas here', () => {
      const editor = mountedEditor();
      expect(editor._mixer.compact).toBe(true);
      expect(editor._mixer.keyboard).toBe(false);
    });

    it('refreshes itself by rewriting that container, never through this.render() (HR-A)', () => {
      const editor = mountedEditor();
      const render = vi.spyOn(editor, 'render');
      editor.element.tracks.innerHTML = '';

      editor._mixer.refresh();

      expect(editor.element.tracks.innerHTML).toContain('game-orchestra-mixer-row');
      // A full re-render at any point after mount detaches the live Drawflow canvas and drags
      // die silently - which a mixer that re-rendered on every mute would trigger constantly.
      expect(render).not.toHaveBeenCalled();
    });

    it('binds its delegated listeners once, not once per refresh', () => {
      const editor = mountedEditor();
      const before = editor.element.tracks.addEventListener.mock.calls.length;

      editor._renderTracks();
      editor._renderTracks();

      expect(editor.element.tracks.addEventListener.mock.calls.length).toBe(before);
    });

    it('tears the controller down when the window closes', () => {
      const editor = mountedEditor();
      const teardown = vi.spyOn(editor._mixer, 'teardown');

      editor._onClose({});

      expect(teardown).toHaveBeenCalled();
      expect(editor._mixer).toBeNull();
    });
  });

  describe('_mountDrawflow / inspector updates (regression: dragging broke because the canvas was torn down mid-mousedown)', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    it('mounts exactly one Drawflow instance even if called multiple times (idempotent)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      const first = editor._drawflow;
      editor._mountDrawflow();

      expect(editor._drawflow).toBe(first);
    });

    it('logs an error and does not throw when the Drawflow global is unavailable', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      expect(() => editor._mountDrawflow()).not.toThrow();
      expect(editor._drawflow).toBeNull();
    });

    it("selecting a node updates the inspector directly and NEVER calls this.render() (the dragging regression)", () => {
      global.Drawflow = createFakeDrawflowClass();
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1]);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      const renderSpy = vi.spyOn(editor, 'render');

      editor._mountDrawflow();
      // Add the node through the normal action flow so it's synced into
      // editor.graph, exactly like a real user building the graph would -
      // _renderInspector() reads from editor.graph, not Drawflow's registry directly.
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'track').id;

      editor._drawflow._fire('nodeSelected', nodeId);

      expect(editor.selectedNodeId).toBe(nodeId);
      expect(editor.element.inspector.innerHTML).toContain('data-change-action="updateTrackLoopCount"');
      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('unselecting a node clears selection and refreshes the inspector without calling this.render()', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      const renderSpy = vi.spyOn(editor, 'render');

      editor._mountDrawflow();
      editor.selectedNodeId = 'something';
      editor._drawflow._fire('nodeUnselected');

      expect(editor.selectedNodeId).toBeNull();
      expect(editor.element.inspector.innerHTML).toContain('GameOrchestra.CustomEditor.Inspector.NoSelection');
      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('adding a node via the palette action syncs the graph and refreshes the inspector without calling this.render()', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      const renderSpy = vi.spyOn(editor, 'render');

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'fork' } });

      expect(editor.graph.nodes.some((n) => n.type === 'fork')).toBe(true);
      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('editing an inspector field patches the live node and refreshes the inspector without calling this.render()', () => {
      global.Drawflow = createFakeDrawflowClass();
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1]);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      const renderSpy = vi.spyOn(editor, 'render');

      editor._mountDrawflow();
      const nodeId = editor._drawflow.addNode('track', 1, 1, 0, 0, 'game-orchestra-node-track', { soundId: 's1', loop: { mode: 'count', count: 1 } }, 'track');
      CustomPlaylistEditor.handleUpdateTrackLoopCount.call(editor, {}, { value: '4', dataset: { nodeId } });

      const trackNode = editor.graph.nodes.find((n) => n.type === 'track');
      expect(trackNode.loop).toEqual({ mode: 'count', count: 4 });
      expect(renderSpy).not.toHaveBeenCalled();
    });

    it('a Track node no longer exposes any way to reassign its sound - the node is placed per sound instead', () => {
      expect(CustomPlaylistEditor.handleUpdateTrackSound).toBeUndefined();
      expect(CustomPlaylistEditor._CHANGE_ACTIONS).not.toHaveProperty('updateTrackSound');
    });

    it('a failed Save validation refreshes the inspector without calling this.render()', async () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      const renderSpy = vi.spyOn(editor, 'render');

      editor._mountDrawflow(); // empty skeleton graph (Start, no exit) is invalid
      await CustomPlaylistEditor.handleSave.call(editor, { preventDefault: vi.fn() }, {});

      // Validation moved out of the inspector body into its own pinned region - see
      // docs/graph-editor-panel-plan.md D4.
      expect(editor.element.validation.innerHTML).toContain('game-orchestra-validation-errors');
      expect(renderSpy).not.toHaveBeenCalled();
    });
  });

  describe('node canvas rendering (icon/detail line) and zoom controls', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    it('renders an icon+label into a newly-added node', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'fork' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'fork').id;

      expect(editor._drawflow._nodeElements.get(nodeId).innerHTML).toContain('fa-code-branch');
    });

    it("updates a Track node's rendered detail line to the sound's name when a sound is selected", () => {
      global.Drawflow = createFakeDrawflowClass();
      const s1 = createMockSound('s1', 'Battle Theme');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1]);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'track').id;
      // The placeholder is a lang key now; the i18n mock echoes keys back.
      expect(editor._drawflow._nodeElements.get(nodeId).innerHTML).toContain('GameOrchestra.CustomEditor.Node.NoSound');

      // A Track node's sound is now fixed at creation, so this is the only route that produces
      // one with a sound - the Tracks pane's "+" button and a drag-in both land here.
      const withSound = editor._addNodeOfType('track', { soundId: 's1' });

      expect(editor._drawflow._nodeElements.get(withSound).innerHTML).toContain('Battle Theme');
    });

    it("grows a Condition node from its live port count, so its shape reacts the instant Add Exit is clicked", () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'condition' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'condition').id;
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'end' } });
      const endId = editor.graph.nodes.find((n) => n.type === 'end').id;
      const nodeEl = editor._drawflow.container.querySelector(`#node-${nodeId}`);

      // A fresh Condition has one port already: its fixed fallback exit.
      expect(nodeEl.style.height).toBe('64px');

      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });
      expect(nodeEl.style.height).toBe('90px');

      // Wiring one of them up doesn't change the count - ports are what matter.
      editor._drawflow._nodes[nodeId].outputs.output_1.connections.push({ node: endId, output: 'input_1' });
      editor._drawflow._fire('connectionCreated', { output_id: nodeId, input_id: endId, output_class: 'output_1', input_class: 'input_1' });

      expect(nodeEl.style.height).toBe('90px');
    });

    it("updates a Fork node's exit count/detail from its live port count, not connections (grows the instant Add Exit is clicked)", () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'fork' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'fork').id;

      // Default Fork starts with 2 output ports, none wired yet.
      expect(editor._drawflow._nodeElements.get(nodeId).innerHTML).toContain('GameOrchestra.CustomEditor.Node.ExitCount 2');

      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });

      expect(editor._drawflow._nodeElements.get(nodeId).innerHTML).toContain('GameOrchestra.CustomEditor.Node.ExitCount 3');
    });

    it("grows a Fork node's inline height as exits are added via the inspector's Add Exit action", () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'fork' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'fork').id;
      const heightAfterCreate = editor._drawflow._nodeOuterElements.get(nodeId).style.height;

      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });
      const heightAfterOneMoreExit = editor._drawflow._nodeOuterElements.get(nodeId).style.height;

      expect(parseInt(heightAfterOneMoreExit, 10)).toBeGreaterThan(parseInt(heightAfterCreate, 10));
    });

    it("forces Drawflow to recompute wire paths after resizing a node (regression: wires stayed drawn at stale coordinates when a node's height changed via inline style)", () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'fork' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'fork').id;

      // _mountDrawflow's own initial refresh pass already resizes the node
      // once, so there's always at least one call by this point; the
      // assertion that matters is that the MOST RECENT call reflects this
      // node's latest resize, with the correct #node-<id> argument.
      expect(editor._drawflow.updateConnectionNodesCalls).toContain(`node-${nodeId}`);

      editor._drawflow.updateConnectionNodesCalls = [];
      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });

      expect(editor._drawflow.updateConnectionNodesCalls).toContain(`node-${nodeId}`);
    });

    it('does not add weight/condition metadata when adding an exit to a Fork node (every exit fires together, nothing to configure)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'fork' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'fork').id;

      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });

      expect(editor._drawflow._nodes[nodeId].data.exits).toBeUndefined();
      expect(Object.keys(editor._drawflow._nodes[nodeId].outputs)).toHaveLength(3); // default 2 + 1 added
    });

    it('does add weight/cooldown metadata when adding an exit to a Random node', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'random' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'random').id;

      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });

      expect(editor._drawflow._nodes[nodeId].data.exits).toHaveLength(2); // default 1 + 1 added
      expect(editor._drawflow._nodes[nodeId].data.exits[1]).toEqual({ weight: 1, cooldown: 0 });
    });

    it("does not set an inline height for node types that don't scale with exit count", () => {
      global.Drawflow = createFakeDrawflowClass();
      const s1 = createMockSound('s1', 'Track 1');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1]);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'track').id;

      expect(editor._drawflow._nodeOuterElements.get(nodeId).style.height).toBe('');
    });

    it('zoom toolbar actions call the corresponding Drawflow zoom method', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleZoomIn.call(editor, { preventDefault: vi.fn() }, {});
      CustomPlaylistEditor.handleZoomOut.call(editor, { preventDefault: vi.fn() }, {});
      CustomPlaylistEditor.handleZoomReset.call(editor, { preventDefault: vi.fn() }, {});

      expect(editor._drawflow.zoomInCalls).toBe(1);
      expect(editor._drawflow.zoomOutCalls).toBe(1);
      expect(editor._drawflow.zoomResetCalls).toBe(1);
    });

    it('zoom actions do not throw when no Drawflow instance is mounted', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      expect(() => CustomPlaylistEditor.handleZoomIn.call(editor, { preventDefault: vi.fn() }, {})).not.toThrow();
    });
  });

  describe('_styleSelfLoopConnections (a node whose own exit feeds back into its own entry)', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    it("overrides a self-loop connection's path to arc above the node instead of Drawflow's default straight-across curve", () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      const nodeId = '5';
      editor.graph = { version: 1, nodes: [{ id: nodeId, type: 'fork' }], edges: [{ id: 'e1', from: nodeId, to: nodeId }] };
      editor._drawflow._nodeOuterElements.set(nodeId, { style: {}, offsetHeight: 80 });
      const pathEl = editor._drawflow.addFakeConnectionPath(nodeId, nodeId, 'M 173 40 C 178 40 95 40 100 40');

      editor._styleSelfLoopConnections(nodeId);

      // Peak should clear the node: min(startY,endY) - (nodeHeight/2 + 40) = 40 - (40+40) = -40.
      expect(pathEl.getAttribute('d')).toBe('M 173 40 C 173 -40 100 -40 100 40');
    });

    it('leaves a normal (non-self-loop) connection untouched', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      editor.graph = {
        version: 1,
        nodes: [{ id: 'a', type: 'start' }, { id: 'b', type: 'end' }],
        edges: [{ id: 'e1', from: 'a', to: 'b' }]
      };
      const originalD = 'M 10 20 C 15 20 95 80 100 80';
      // No connection registered from 'a' to itself, so a self-loop query
      // against node 'a' should find nothing to touch.
      editor._drawflow.addFakeConnectionPath('a', 'b', originalD);

      expect(() => editor._styleSelfLoopConnections('a')).not.toThrow();
    });

    it('does nothing when the node has no self-loop edge (no unnecessary DOM queries/writes)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      editor.graph = { version: 1, nodes: [{ id: 'a', type: 'track' }], edges: [] };
      const querySpy = vi.spyOn(editor._drawflow.container, 'querySelectorAll');

      editor._styleSelfLoopConnections('a');

      expect(querySpy).not.toHaveBeenCalled();
    });

    it('is applied automatically by _refreshNodeDisplay (e.g. right after Add Exit resizes a Fork node)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'fork' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'fork').id;
      editor.graph.edges.push({ id: 'loop', from: nodeId, to: nodeId });
      const pathEl = editor._drawflow.addFakeConnectionPath(nodeId, nodeId, 'M 64 40 C 69 40 -5 40 0 40');

      editor._refreshNodeDisplay(nodeId);

      // Just confirm it changed from the flat default - exact numbers already
      // covered by the dedicated test above.
      expect(pathEl.getAttribute('d')).not.toBe('M 64 40 C 69 40 -5 40 0 40');
    });
  });

  describe('handleRemoveCustomPlayback (confirmation dialog)', () => {
    it('unsets the flag when the user confirms', async () => {
      foundry.applications.api.DialogV2.confirm = vi.fn(() => Promise.resolve(true));
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.close = vi.fn();

      await CustomPlaylistEditor.handleRemoveCustomPlayback.call(editor, { preventDefault: vi.fn() }, {});

      expect(foundry.applications.api.DialogV2.confirm).toHaveBeenCalled();
      expect(playlist.unsetFlag).toHaveBeenCalledWith('game-orchestra', 'customPlayback');
      expect(editor.close).toHaveBeenCalled();
    });

    it('does nothing when the user cancels the confirmation dialog', async () => {
      foundry.applications.api.DialogV2.confirm = vi.fn(() => Promise.resolve(false));
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.close = vi.fn();

      await CustomPlaylistEditor.handleRemoveCustomPlayback.call(editor, { preventDefault: vi.fn() }, {});

      expect(playlist.unsetFlag).not.toHaveBeenCalled();
      expect(editor.close).not.toHaveBeenCalled();
    });
  });

  describe('handleSave / handleRemoveCustomPlayback do not directly rebuild the engine (regression: double rebuild)', () => {
    // setFlag()/unsetFlag() firing Foundry's 'updatePlaylist' hook - and hooks.mjs's
    // handleUpdatePlaylist() forwarding that to onCustomGraphChanged() - is the
    // single designed trigger (see the comments in custom-playlist-editor.mjs).
    // These assert the editor itself no longer calls onCustomGraphChanged directly,
    // which would otherwise rebuild the engine twice per save/remove.
    it('handleSave does not call musicController.onCustomGraphChanged directly', async () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.graph = { version: 1, nodes: [{ id: 'start', type: 'start' }, { id: 'end', type: 'end' }], edges: [{ id: 'e1', from: 'start', to: 'end' }] };
      editor.close = vi.fn();
      const onCustomGraphChanged = vi.fn();
      game.gameOrchestra = { musicController: { onCustomGraphChanged } };

      await CustomPlaylistEditor.handleSave.call(editor, { preventDefault: vi.fn() }, {});

      expect(playlist.setFlag).toHaveBeenCalledWith('game-orchestra', 'customPlayback', editor.graph);
      expect(onCustomGraphChanged).not.toHaveBeenCalled();
      expect(editor.close).toHaveBeenCalled();
    });

    it('handleRemoveCustomPlayback does not call musicController.onCustomGraphChanged directly', async () => {
      foundry.applications.api.DialogV2.confirm = vi.fn(() => Promise.resolve(true));
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.close = vi.fn();
      const onCustomGraphChanged = vi.fn();
      game.gameOrchestra = { musicController: { onCustomGraphChanged } };

      await CustomPlaylistEditor.handleRemoveCustomPlayback.call(editor, { preventDefault: vi.fn() }, {});

      expect(playlist.unsetFlag).toHaveBeenCalledWith('game-orchestra', 'customPlayback');
      expect(onCustomGraphChanged).not.toHaveBeenCalled();
      expect(editor.close).toHaveBeenCalled();
    });
  });

  describe('Track infinite playback (loop forever, no exit)', () => {
    it("defaults new Track nodes to finite (loop: { mode: 'count', count: 1 }) with one exit port", () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const node = editor.graph.nodes.find((n) => n.type === 'track');

      expect(node.loop).toEqual({ mode: 'count', count: 1 });
      const liveNode = editor._drawflow.getNodeFromId(node.id);
      expect(Object.keys(liveNode.outputs)).toEqual(['output_1']);
    });

    it('enabling infinite removes the exit port and switches loop.mode to forever', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'track').id;

      CustomPlaylistEditor.handleUpdateTrackInfinite.call(editor, {}, { checked: true, dataset: { nodeId } });

      const node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.loop).toEqual({ mode: 'forever' });
      const liveNode = editor._drawflow.getNodeFromId(nodeId);
      expect(Object.keys(liveNode.outputs)).toEqual([]);
    });

    it('disabling infinite restores the exit port and a default loop count', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'track').id;
      CustomPlaylistEditor.handleUpdateTrackInfinite.call(editor, {}, { checked: true, dataset: { nodeId } });

      CustomPlaylistEditor.handleUpdateTrackInfinite.call(editor, {}, { checked: false, dataset: { nodeId } });

      const node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.loop).toEqual({ mode: 'count', count: 1 });
      const liveNode = editor._drawflow.getNodeFromId(nodeId);
      expect(Object.keys(liveNode.outputs)).toEqual(['output_1']);
    });

    it('removing an already-wired exit before enabling infinite does not throw (removeNodeOutput only called once)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'track').id;

      expect(() => {
        CustomPlaylistEditor.handleUpdateTrackInfinite.call(editor, {}, { checked: true, dataset: { nodeId } });
        CustomPlaylistEditor.handleUpdateTrackInfinite.call(editor, {}, { checked: true, dataset: { nodeId } });
      }).not.toThrow();
    });
  });

  describe("Track loop.mode 'until' (loop until a condition is met)", () => {
    function addTrackNode(editor) {
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      return editor.graph.nodes.find((n) => n.type === 'track').id;
    }

    it('enabling the Until toggle switches to a default until-loop without touching the exit port', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = addTrackNode(editor);

      CustomPlaylistEditor.handleUpdateTrackUntilToggle.call(editor, {}, { checked: true, dataset: { nodeId } });

      const node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.loop).toEqual({ mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null });
      const liveNode = editor._drawflow.getNodeFromId(nodeId);
      expect(Object.keys(liveNode.outputs)).toEqual(['output_1']);
    });

    it('disabling the Until toggle reverts to loop: { mode: count, count: 1 }', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = addTrackNode(editor);
      CustomPlaylistEditor.handleUpdateTrackUntilToggle.call(editor, {}, { checked: true, dataset: { nodeId } });

      CustomPlaylistEditor.handleUpdateTrackUntilToggle.call(editor, {}, { checked: false, dataset: { nodeId } });

      const node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.loop).toEqual({ mode: 'count', count: 1 });
    });

    it('handleUpdateTrackUntilKind replaces the condition (dropping any prior value)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = addTrackNode(editor);
      CustomPlaylistEditor.handleUpdateTrackUntilToggle.call(editor, {}, { checked: true, dataset: { nodeId } });
      CustomPlaylistEditor.handleUpdateTrackUntilValue.call(editor, {}, { value: 'stale', dataset: { nodeId } });

      CustomPlaylistEditor.handleUpdateTrackUntilKind.call(editor, {}, { value: 'phase', dataset: { nodeId } });

      const node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.loop.condition).toEqual({ kind: 'phase' });
    });

    it('handleUpdateTrackUntilValue sets the condition value, and blank clears it', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = addTrackNode(editor);
      CustomPlaylistEditor.handleUpdateTrackUntilToggle.call(editor, {}, { checked: true, dataset: { nodeId } });
      CustomPlaylistEditor.handleUpdateTrackUntilKind.call(editor, {}, { value: 'mood', dataset: { nodeId } });

      CustomPlaylistEditor.handleUpdateTrackUntilValue.call(editor, {}, { value: 'boss', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.condition).toEqual({ kind: 'mood', value: 'boss' });

      CustomPlaylistEditor.handleUpdateTrackUntilValue.call(editor, {}, { value: '', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.condition).toEqual({ kind: 'mood', value: undefined });
    });

    it('handleUpdateTrackUntilBoundary accepts loopEnd and defaults anything else to immediate', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = addTrackNode(editor);
      CustomPlaylistEditor.handleUpdateTrackUntilToggle.call(editor, {}, { checked: true, dataset: { nodeId } });

      CustomPlaylistEditor.handleUpdateTrackUntilBoundary.call(editor, {}, { value: 'loopEnd', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.boundary).toBe('loopEnd');

      CustomPlaylistEditor.handleUpdateTrackUntilBoundary.call(editor, {}, { value: 'nonsense', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.boundary).toBe('immediate');
    });

    it('handleUpdateTrackUntilMinLoops coerces missing/invalid/sub-1 values to 1', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = addTrackNode(editor);
      CustomPlaylistEditor.handleUpdateTrackUntilToggle.call(editor, {}, { checked: true, dataset: { nodeId } });

      CustomPlaylistEditor.handleUpdateTrackUntilMinLoops.call(editor, {}, { value: '4', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.minLoops).toBe(4);

      CustomPlaylistEditor.handleUpdateTrackUntilMinLoops.call(editor, {}, { value: '0', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.minLoops).toBe(1);

      CustomPlaylistEditor.handleUpdateTrackUntilMinLoops.call(editor, {}, { value: 'nope', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.minLoops).toBe(1);
    });

    it('handleUpdateTrackUntilMaxLoops accepts a positive value and clears to null on blank/zero/negative', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = addTrackNode(editor);
      CustomPlaylistEditor.handleUpdateTrackUntilToggle.call(editor, {}, { checked: true, dataset: { nodeId } });

      CustomPlaylistEditor.handleUpdateTrackUntilMaxLoops.call(editor, {}, { value: '6', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.maxLoops).toBe(6);

      CustomPlaylistEditor.handleUpdateTrackUntilMaxLoops.call(editor, {}, { value: '0', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.maxLoops).toBeNull();

      CustomPlaylistEditor.handleUpdateTrackUntilMaxLoops.call(editor, {}, { value: '', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.maxLoops).toBeNull();

      CustomPlaylistEditor.handleUpdateTrackUntilMaxLoops.call(editor, {}, { value: '-3', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop.maxLoops).toBeNull();
    });

    it('the until sub-field handlers are no-ops on a Track node that is not in until mode', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = addTrackNode(editor); // stays count-mode

      CustomPlaylistEditor.handleUpdateTrackUntilKind.call(editor, {}, { value: 'phase', dataset: { nodeId } });
      CustomPlaylistEditor.handleUpdateTrackUntilBoundary.call(editor, {}, { value: 'loopEnd', dataset: { nodeId } });
      CustomPlaylistEditor.handleUpdateTrackUntilMinLoops.call(editor, {}, { value: '3', dataset: { nodeId } });
      CustomPlaylistEditor.handleUpdateTrackUntilMaxLoops.call(editor, {}, { value: '5', dataset: { nodeId } });

      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop).toEqual({ mode: 'count', count: 1 });
    });
  });

  describe('Playlist node references (docs/playlist-node-plan.md)', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    it('adding a Playlist node from the palette creates it with one output port and a default (unset direct) reference', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'playlist' } });
      const node = editor.graph.nodes.find((n) => n.type === 'playlist');

      expect(node.playlistRef).toEqual({ source: 'direct', playlistId: null });
      expect(node.loop).toEqual({ mode: 'count', count: 1 });
      const liveNode = editor._drawflow.getNodeFromId(node.id);
      expect(Object.keys(liveNode.outputs)).toEqual(['output_1']);
    });

    it('toggling Loop Forever removes the output port and switches loop.mode, and restores both when unchecked', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'playlist' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'playlist').id;

      CustomPlaylistEditor.handleUpdatePlaylistInfinite.call(editor, {}, { checked: true, dataset: { nodeId } });
      let node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.loop).toEqual({ mode: 'forever' });
      expect(Object.keys(editor._drawflow.getNodeFromId(nodeId).outputs)).toEqual([]);

      CustomPlaylistEditor.handleUpdatePlaylistInfinite.call(editor, {}, { checked: false, dataset: { nodeId } });
      node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.loop).toEqual({ mode: 'count', count: 1 });
      expect(Object.keys(editor._drawflow.getNodeFromId(nodeId).outputs)).toEqual(['output_1']);
    });

    it('handleUpdatePlaylistTarget sets a direct target id', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'playlist' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'playlist').id;

      CustomPlaylistEditor.handleUpdatePlaylistTarget.call(editor, {}, { value: 'pl-target', dataset: { nodeId } });

      const node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.playlistRef).toEqual({ source: 'direct', playlistId: 'pl-target' });
    });

    it('handleUpdatePlaylistSource re-normalizes the ref, dropping stale fields left over from the previous source', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'playlist' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'playlist').id;
      CustomPlaylistEditor.handleUpdatePlaylistTarget.call(editor, {}, { value: 'pl-target', dataset: { nodeId } });

      // direct -> scene: the stale playlistId must not survive.
      CustomPlaylistEditor.handleUpdatePlaylistSource.call(editor, {}, { value: 'scene', dataset: { nodeId } });
      let node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.playlistRef).toEqual({ source: 'scene', section: 'area', overlayMode: 'active' });

      // scene -> direct: the stale section/overlayMode must not survive either.
      CustomPlaylistEditor.handleUpdatePlaylistSource.call(editor, {}, { value: 'direct', dataset: { nodeId } });
      node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.playlistRef).toEqual({ source: 'direct', playlistId: null });
    });

    it('handleUpdatePlaylistSection / OverlayMode / OverlayId update an indirect reference in place', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'playlist' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'playlist').id;
      CustomPlaylistEditor.handleUpdatePlaylistSource.call(editor, {}, { value: 'default', dataset: { nodeId } });

      CustomPlaylistEditor.handleUpdatePlaylistSection.call(editor, {}, { value: 'combat', dataset: { nodeId } });
      CustomPlaylistEditor.handleUpdatePlaylistOverlayMode.call(editor, {}, { value: 'specific', dataset: { nodeId } });
      CustomPlaylistEditor.handleUpdatePlaylistOverlayId.call(editor, {}, { value: 'boss', dataset: { nodeId } });

      const node = editor.graph.nodes.find((n) => n.id === nodeId);
      expect(node.playlistRef).toEqual({ source: 'default', section: 'combat', overlayMode: 'specific', overlayId: 'boss' });
    });

    it('handleUpdatePlaylistLoopCount clamps to a minimum of 1', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'playlist' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'playlist').id;

      CustomPlaylistEditor.handleUpdatePlaylistLoopCount.call(editor, {}, { value: '0', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop).toEqual({ mode: 'count', count: 1 });

      CustomPlaylistEditor.handleUpdatePlaylistLoopCount.call(editor, {}, { value: '5', dataset: { nodeId } });
      expect(editor.graph.nodes.find((n) => n.id === nodeId).loop).toEqual({ mode: 'count', count: 5 });
    });

    it('_prepareContext omits the edited playlist itself from playlistOptions, but includes other playlists', () => {
      const otherPlaylist = createMockPlaylist('pl-other', 'Other Playlist', []);
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      game.playlists = Object.assign([playlist, otherPlaylist], { get: vi.fn(), playing: [] });

      const editor = new CustomPlaylistEditor(playlist);
      const ctx = editor._prepareContext({});

      expect(ctx.playlistOptions.map((p) => p.id)).toEqual(['pl-other']);
    });

    it('_prepareContext marks the currently-selected direct target as selected in playlistOptions', () => {
      const otherPlaylist = createMockPlaylist('pl-other', 'Other Playlist', []);
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      game.playlists = Object.assign([playlist, otherPlaylist], { get: vi.fn(), playing: [] });

      const editor = new CustomPlaylistEditor(playlist);
      editor.graph = {
        version: 1,
        nodes: [{ id: 'p1', type: 'playlist', playlistRef: { source: 'direct', playlistId: 'pl-other' }, loop: { mode: 'count', count: 1 } }],
        edges: []
      };
      editor.selectedNodeId = 'p1';

      const ctx = editor._prepareContext({});
      expect(ctx.playlistOptions).toEqual([{ id: 'pl-other', name: 'Other Playlist', selected: true }]);
    });

    it('_prepareContext builds overlayOptions from the configured moods setting for an area ref, marking the selected one', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      setMockSetting('game-orchestra', 'configuredMoods', [{ id: 'calm', label: 'Calm' }, { id: 'boss', label: 'Boss Fight' }]);

      const editor = new CustomPlaylistEditor(playlist);
      editor.graph = {
        version: 1,
        nodes: [{ id: 'p1', type: 'playlist', playlistRef: { source: 'scene', section: 'area', overlayMode: 'specific', overlayId: 'boss' }, loop: { mode: 'count', count: 1 } }],
        edges: []
      };
      editor.selectedNodeId = 'p1';

      const ctx = editor._prepareContext({});
      expect(ctx.overlayOptions).toEqual([
        { id: 'calm', label: 'Calm', selected: false },
        { id: 'boss', label: 'Boss Fight', selected: true }
      ]);
    });

    it('_prepareContext builds overlayOptions from the configured phases setting for a combat ref', () => {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      setMockSetting('game-orchestra', 'configuredPhases', [{ id: 'p1', label: 'Phase One' }, { id: 'enrage', label: 'Enrage' }]);

      const editor = new CustomPlaylistEditor(playlist);
      editor.graph = {
        version: 1,
        nodes: [{ id: 'pn1', type: 'playlist', playlistRef: { source: 'scene', section: 'combat', overlayMode: 'specific', overlayId: 'enrage' }, loop: { mode: 'count', count: 1 } }],
        edges: []
      };
      editor.selectedNodeId = 'pn1';

      const ctx = editor._prepareContext({});
      expect(ctx.overlayOptions).toEqual([
        { id: 'p1', label: 'Phase One', selected: false },
        { id: 'enrage', label: 'Enrage', selected: true }
      ]);
    });

    it('the inspector renders the direct branch when source is direct, and the section/mood branch when indirect', () => {
      global.Drawflow = createFakeDrawflowClass();
      const otherPlaylist = createMockPlaylist('pl-other', 'Other Playlist', []);
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      game.playlists = Object.assign([playlist, otherPlaylist], { get: vi.fn(), playing: [] });

      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'playlist' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'playlist').id;
      editor.selectedNodeId = nodeId;
      editor._renderInspector();

      expect(editor.element.inspector.innerHTML).toContain('data-change-action="updatePlaylistTarget"');
      expect(editor.element.inspector.innerHTML).not.toContain('data-change-action="updatePlaylistSection"');

      CustomPlaylistEditor.handleUpdatePlaylistSource.call(editor, {}, { value: 'scene', dataset: { nodeId } });

      expect(editor.element.inspector.innerHTML).toContain('data-change-action="updatePlaylistSection"');
      expect(editor.element.inspector.innerHTML).not.toContain('data-change-action="updatePlaylistTarget"');
    });

    it("the canvas detail line shows the resolved reference label and pass count", () => {
      global.Drawflow = createFakeDrawflowClass();
      const targetPlaylist = createMockPlaylist('pl-target', 'Tavern Theme', []);
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      game.playlists = Object.assign([playlist, targetPlaylist], { get: vi.fn((id) => (id === 'pl-target' ? targetPlaylist : null)), playing: [] });

      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'playlist' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'playlist').id;
      CustomPlaylistEditor.handleUpdatePlaylistTarget.call(editor, {}, { value: 'pl-target', dataset: { nodeId } });
      CustomPlaylistEditor.handleUpdatePlaylistLoopCount.call(editor, {}, { value: '3', dataset: { nodeId } });

      const contentEl = editor._drawflow._nodeElements.get(nodeId);
      expect(contentEl.innerHTML).toContain('Tavern Theme × 3');
    });
  });

  // REPORTED LIVE: pressing Delete with several nodes rect-selected removed nothing. Drawflow's
  // own key handler only ever removes `this.node_selected`, and a marquee selection deliberately
  // leaves that null - the whole selection is this module's concept.
  describe('deleting a marquee selection (Delete / Backspace)', () => {
    function deleteKey(key = 'Delete') {
      return { key, ctrlKey: false, metaKey: false, preventDefault: vi.fn(), target: document.body };
    }

    function editorWithNodes() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      return editor;
    }

    afterEach(() => {
      delete global.Drawflow;
    });

    it.each([['Delete'], ['Backspace']])('%s removes every marquee-selected node at once', (key) => {
      const editor = editorWithNodes();
      const a = editor._addNodeOfType('track');
      const b = editor._addNodeOfType('delay');
      const c = editor._addNodeOfType('fork');
      editor._multiSelectedNodeIds = new Set([a, b]);

      editor._onKeyDown(deleteKey(key));

      const ids = editor.graph.nodes.map((n) => n.id);
      expect(ids).not.toContain(a);
      expect(ids).not.toContain(b);
      expect(ids).toContain(c); // an unselected node is untouched
      expect(editor._multiSelectedNodeIds.size).toBe(0);
    });

    it('also drops the wires attached to the deleted nodes, not just the nodes', () => {
      const editor = editorWithNodes();
      const a = editor._addNodeOfType('track');
      const b = editor._addNodeOfType('delay');
      editor._drawflow.addConnection(a, b, 'output_1', 'input_1');
      editor._syncFromDrawflow(editor._drawflow);
      expect(editor.graph.edges).toHaveLength(1);
      editor._multiSelectedNodeIds = new Set([b]);

      editor._onKeyDown(deleteKey());

      expect(editor.graph.edges).toEqual([]);
    });

    it('skips the Start node and says why, while still deleting the rest of the selection', () => {
      const editor = editorWithNodes();
      const startId = editor.graph.nodes.find((n) => n.type === 'start').id;
      const track = editor._addNodeOfType('track');
      editor._multiSelectedNodeIds = new Set([startId, track]);

      editor._onKeyDown(deleteKey());

      const ids = editor.graph.nodes.map((n) => n.id);
      expect(ids).toContain(startId);
      expect(ids).not.toContain(track);
      expect(global.ui.notifications.warn).toHaveBeenCalledWith('GameOrchestra.CustomEditor.Canvas.CannotDeleteStart');
    });

    it('leaves a single Drawflow-selected node to Drawflow\'s own handler - deleting it twice is not this class\'s job', () => {
      const editor = editorWithNodes();
      const track = editor._addNodeOfType('track');
      editor.selectedNodeId = track;
      const event = deleteKey();

      editor._onKeyDown(event);

      expect(editor.graph.nodes.map((n) => n.id)).toContain(track);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    it('ignores Delete while a text field has focus, so backspacing in a node-name field still works', () => {
      const editor = editorWithNodes();
      const track = editor._addNodeOfType('track');
      editor._multiSelectedNodeIds = new Set([track]);
      // No real DOM here (vitest environment: 'node') - simulate a focused text field the way a
      // browser exposes it, matching the copy/paste focus-guard test further down.
      document.activeElement = { tagName: 'INPUT' };
      try {
        editor._onKeyDown(deleteKey('Backspace'));
        expect(editor.graph.nodes.map((n) => n.id)).toContain(track);
      } finally {
        document.activeElement = undefined;
      }
    });
  });

  describe('copy/paste (Ctrl+C / Ctrl+V on a selected node)', () => {
    const nodeElTarget = (editor, nodeId) => editor._drawflow.container.querySelector(`#node-${nodeId}`);

    function ctrlKey(key) {
      return { key, ctrlKey: true, metaKey: false, preventDefault: vi.fn(), target: document.body };
    }

    it('copies the selected node and pastes a new, offset, unconnected clone of it', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      editor._addNodeOfType('track', { soundId: 's1' });
      const original = editor.graph.nodes.find((n) => n.type === 'track');
      editor.selectedNodeId = original.id;

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));

      const trackNodes = editor.graph.nodes.filter((n) => n.type === 'track');
      expect(trackNodes).toHaveLength(2);
      const pasted = trackNodes.find((n) => n.id !== original.id);
      expect(pasted.soundId).toBe('s1');
      expect(pasted.x).not.toBe(original.x);
      expect(editor.graph.edges).toEqual([]); // a paste is never pre-wired
    });

    it('a non-empty marquee (multi) selection copies/pastes every node in it, preserving their relative layout', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'delay' } });
      const trackId = editor.graph.nodes.find((n) => n.type === 'track').id;
      const delayId = editor.graph.nodes.find((n) => n.type === 'delay').id;
      // A single selectedNodeId set (as if left over from before the marquee
      // drag) must NOT leak into the copy - only the marquee set should be used.
      editor.selectedNodeId = 'start';
      editor._multiSelectedNodeIds = new Set([trackId, delayId]);

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));

      expect(editor.graph.nodes.filter((n) => n.type === 'track')).toHaveLength(2);
      expect(editor.graph.nodes.filter((n) => n.type === 'delay')).toHaveLength(2);
      expect(editor.graph.nodes.filter((n) => n.type === 'start')).toHaveLength(1); // never duplicated
    });

    it('skips Start within a multi-selection but still copies/pastes the rest of the group', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const trackId = editor.graph.nodes.find((n) => n.type === 'track').id;
      editor._multiSelectedNodeIds = new Set(['start', trackId]);

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));

      expect(ui.notifications.warn).toHaveBeenCalled();
      expect(editor.graph.nodes.filter((n) => n.type === 'start')).toHaveLength(1);
      expect(editor.graph.nodes.filter((n) => n.type === 'track')).toHaveLength(2);
    });

    it('refuses to copy the Start node (only one is allowed)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const startNode = editor.graph.nodes.find((n) => n.type === 'start');
      editor.selectedNodeId = startNode.id;

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));

      expect(ui.notifications.warn).toHaveBeenCalled();
      expect(editor.graph.nodes.filter((n) => n.type === 'start')).toHaveLength(1);
    });

    it('assigns distinct labels when pasting two nodes of the SAME type in one batch (regression: deferring the graph sync to after the loop must not let two pasted nodes collide on a label)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const trackIds = editor.graph.nodes.filter((n) => n.type === 'track').map((n) => n.id);
      editor._multiSelectedNodeIds = new Set(trackIds);

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));

      const trackLabels = editor.graph.nodes.filter((n) => n.type === 'track').map((n) => n.label);
      expect(trackLabels).toHaveLength(4);
      expect(new Set(trackLabels).size).toBe(4); // every label unique - none collided
    });

    it('selects a single pasted node, exactly as clicking it would', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const original = editor.graph.nodes.find((n) => n.type === 'track');
      editor.selectedNodeId = original.id;

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));

      const pasted = editor.graph.nodes.find((n) => n.type === 'track' && n.id !== original.id);
      expect(editor.selectedNodeId).toBe(pasted.id);
      expect(editor._multiSelectedNodeIds.size).toBe(0); // a single paste is not a marquee
      expect(nodeElTarget(editor, pasted.id).classList.contains('selected')).toBe(true);
      expect(editor._drawflow.node_selected).toBe(nodeElTarget(editor, pasted.id));
    });

    it('marquee-selects a multi-node paste, leaving the originals deselected', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'delay' } });
      const originalIds = editor.graph.nodes.filter((n) => n.type !== 'start').map((n) => n.id);
      editor._multiSelectedNodeIds = new Set(originalIds);

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));

      const pastedIds = editor.graph.nodes.filter((n) => n.type !== 'start' && !originalIds.includes(n.id)).map((n) => n.id);
      expect(pastedIds).toHaveLength(2);
      expect([...editor._multiSelectedNodeIds].sort()).toEqual([...pastedIds].sort());
      for (const id of pastedIds) expect(nodeElTarget(editor, id).classList.contains('game-orchestra-multi-selected')).toBe(true);
      for (const id of originalIds) expect(nodeElTarget(editor, id).classList.contains('game-orchestra-multi-selected')).toBe(false);
      expect(editor.selectedNodeId).toBeNull(); // marquee and single selection never coexist
    });

    it('leaves only the newest paste selected when pasting repeatedly', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'delay' } });
      editor._multiSelectedNodeIds = new Set(editor.graph.nodes.filter((n) => n.type !== 'start').map((n) => n.id));

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));
      const firstPaste = [...editor._multiSelectedNodeIds];
      editor._onKeyDown(ctrlKey('v'));

      expect(editor._multiSelectedNodeIds.size).toBe(2);
      for (const id of firstPaste) {
        expect(editor._multiSelectedNodeIds.has(id)).toBe(false);
        expect(nodeElTarget(editor, id).classList.contains('game-orchestra-multi-selected')).toBe(false);
      }
    });

    it('does nothing on paste when nothing has been copied yet', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeCountBefore = editor.graph.nodes.length;

      editor._onKeyDown(ctrlKey('v'));

      expect(editor.graph.nodes).toHaveLength(nodeCountBefore);
    });

    it('ignores the shortcut while a text field elsewhere has focus, so normal text copy/paste still works', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const original = editor.graph.nodes.find((n) => n.type === 'track');
      editor.selectedNodeId = original.id;

      // This test environment has no real DOM (vitest environment: 'node') -
      // document is the plain stub from setupFoundryMocks(). Simulate an
      // unrelated text field having focus the same way a real browser would
      // expose it: document.activeElement with a form-control tagName.
      document.activeElement = { tagName: 'INPUT' };
      try {
        editor._onKeyDown(ctrlKey('c'));
        editor._onKeyDown(ctrlKey('v'));
        expect(editor.graph.nodes.filter((n) => n.type === 'track')).toHaveLength(1); // no copy happened
      } finally {
        document.activeElement = undefined;
      }
    });

    it("preserves a Random node's exits/avoidRepeat and output port count on paste", () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'random' } });
      const original = editor.graph.nodes.find((n) => n.type === 'random');
      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId: original.id } });
      CustomPlaylistEditor.handleUpdateRandomAvoidRepeat.call(editor, {}, { checked: true, dataset: { nodeId: original.id } });
      editor.selectedNodeId = original.id;

      editor._onKeyDown(ctrlKey('c'));
      editor._onKeyDown(ctrlKey('v'));

      const pasted = editor.graph.nodes.find((n) => n.type === 'random' && n.id !== original.id);
      expect(pasted.avoidRepeat).toBe(true);
      const liveNode = editor._drawflow.getNodeFromId(pasted.id);
      expect(Object.keys(liveNode.outputs)).toHaveLength(2);
    });
  });

  describe('_isBackgroundTarget', () => {
    it('is true for an element with no relevant ancestors (empty canvas)', () => {
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      const target = { closest: () => null, classList: { contains: () => false } };
      expect(editor._isBackgroundTarget(target)).toBe(true);
    });

    it('is false for a target inside a node', () => {
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      const target = { closest: (sel) => (sel === '.drawflow-node' ? {} : null), classList: { contains: () => false } };
      expect(editor._isBackgroundTarget(target)).toBe(false);
    });

    it('is false for a port element', () => {
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      const target = { closest: () => null, classList: { contains: (c) => c === 'output' } };
      expect(editor._isBackgroundTarget(target)).toBe(false);
    });

    it('is false for a connection wire', () => {
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      const target = { closest: (sel) => (sel === '.main-path' ? {} : null), classList: { contains: () => false } };
      expect(editor._isBackgroundTarget(target)).toBe(false);
    });
  });

  describe('right-click pans, left-click-drag rect-selects (canvas mousedown gating)', () => {
    const bgTarget = () => ({ closest: () => null, classList: { contains: () => false } });
    const nodeTarget = () => ({ closest: (sel) => (sel === '.drawflow-node' ? {} : null), classList: { contains: () => false } });

    it('right-button mousedown on empty canvas is left untouched for Drawflow\'s native pan', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();

      const event = { button: 2, target: bgTarget(), stopPropagation: vi.fn(), clientX: 10, clientY: 10 };
      editor._onCanvasMouseDown(event);

      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(editor._rectSelectStart).toBeUndefined();
    });

    it('left-button mousedown on a node is left untouched (Drawflow handles its own node clicks/drags)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();

      const event = { button: 0, target: nodeTarget(), stopPropagation: vi.fn(), clientX: 10, clientY: 10 };
      editor._onCanvasMouseDown(event);

      expect(event.stopPropagation).not.toHaveBeenCalled();
      expect(editor._rectSelectStart).toBeUndefined();
    });

    it('left-button mousedown on empty canvas stops propagation (pre-empting Drawflow\'s pan) and starts a rect-select', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();

      const event = { button: 0, target: bgTarget(), stopPropagation: vi.fn(), clientX: 15, clientY: 25 };
      editor._onCanvasMouseDown(event);

      expect(event.stopPropagation).toHaveBeenCalled();
      expect(editor._rectSelectStart).toEqual({ x: 15, y: 25 });
    });

    it('a plain click (no movement) on empty canvas deselects both the single and multi selections', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      editor.selectedNodeId = 'start';
      editor._multiSelectedNodeIds.add('start');

      editor._onCanvasMouseDown({ button: 0, target: bgTarget(), stopPropagation: vi.fn(), clientX: 15, clientY: 25 });
      editor._onRectSelectUp({ clientX: 15, clientY: 25 }); // no movement from mousedown

      expect(editor.selectedNodeId).toBeNull();
      expect(editor._multiSelectedNodeIds.size).toBe(0);
    });

    it('a drag rect-selects exactly the nodes whose box intersects the rectangle', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'delay' } });
      const trackId = editor.graph.nodes.find((n) => n.type === 'track').id;
      const delayId = editor.graph.nodes.find((n) => n.type === 'delay').id;

      editor._drawflow.container.querySelector(`#node-${trackId}`).getBoundingClientRect = () => ({ left: 10, right: 50, top: 10, bottom: 50 });
      editor._drawflow.container.querySelector(`#node-${delayId}`).getBoundingClientRect = () => ({ left: 500, right: 540, top: 500, bottom: 540 });

      editor._onCanvasMouseDown({ button: 0, target: bgTarget(), stopPropagation: vi.fn(), clientX: 0, clientY: 0 });
      editor._onRectSelectMove({ clientX: 60, clientY: 60 }); // past the click/drag threshold
      editor._onRectSelectUp({ clientX: 60, clientY: 60 });

      expect(editor._multiSelectedNodeIds.has(trackId)).toBe(true);
      expect(editor._multiSelectedNodeIds.has(delayId)).toBe(false);
      expect(editor._drawflow.container.querySelector(`#node-${trackId}`).classList.contains('game-orchestra-multi-selected')).toBe(true);
      expect(editor._drawflow.container.querySelector(`#node-${delayId}`).classList.contains('game-orchestra-multi-selected')).toBe(false);
    });

    describe('dragging a marquee selection moves every selected node together', () => {
      /** An editor with a track and a delay node, both marquee-selected at a known position. */
      function editorWithSelectedPair() {
        global.Drawflow = createFakeDrawflowClass();
        const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
        editor.element = createFakeElement();
        editor._mountDrawflow();

        CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
        CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'delay' } });
        const trackId = editor.graph.nodes.find((n) => n.type === 'track').id;
        const delayId = editor.graph.nodes.find((n) => n.type === 'delay').id;

        for (const [id, left, top] of [[trackId, 100, 100], [delayId, 300, 200]]) {
          const el = editor._drawflow.container.querySelector(`#node-${id}`);
          el.style.left = `${left}px`;
          el.style.top = `${top}px`;
          editor._drawflow._nodes[id].pos_x = left;
          editor._drawflow._nodes[id].pos_y = top;
          editor._multiSelectedNodeIds.add(id);
          el.classList.add('game-orchestra-multi-selected');
        }
        return { editor, trackId, delayId };
      }

      const nodeElTarget = (editor, nodeId) => editor._drawflow.container.querySelector(`#node-${nodeId}`);

      it("pre-empts Drawflow's own node drag when the press lands on a selected node", () => {
        const { editor, trackId } = editorWithSelectedPair();
        const event = { button: 0, target: nodeElTarget(editor, trackId), stopPropagation: vi.fn(), clientX: 10, clientY: 10 };

        editor._onCanvasMouseDown(event);

        // Without this, Drawflow fires 'nodeSelected' - which collapses the
        // marquee down to one node - and then drags only that node.
        expect(event.stopPropagation).toHaveBeenCalled();
        expect(editor._groupDrag.nodeIds).toEqual(expect.arrayContaining([trackId]));
        expect(editor._rectSelectStart).toBeUndefined();
      });

      it('leaves a press on an UNselected node to Drawflow', () => {
        const { editor, trackId, delayId } = editorWithSelectedPair();
        editor._multiSelectedNodeIds.delete(delayId);
        const event = { button: 0, target: nodeElTarget(editor, delayId), stopPropagation: vi.fn(), clientX: 10, clientY: 10 };

        editor._onCanvasMouseDown(event);

        expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(editor._groupDrag).toBeUndefined();
        expect(editor._multiSelectedNodeIds.has(trackId)).toBe(true);
      });

      it('leaves a press on a port alone so it still starts a connection drag', () => {
        const { editor, trackId } = editorWithSelectedPair();
        const port = { classList: { contains: (c) => c === 'output' }, closest: () => nodeElTarget(editor, trackId) };
        const event = { button: 0, target: port, stopPropagation: vi.fn(), clientX: 10, clientY: 10 };

        editor._onCanvasMouseDown(event);

        expect(event.stopPropagation).not.toHaveBeenCalled();
        expect(editor._groupDrag).toBeUndefined();
      });

      it('moves every selected node by the same delta and keeps the selection', () => {
        const { editor, trackId, delayId } = editorWithSelectedPair();

        editor._onCanvasMouseDown({ button: 0, target: nodeElTarget(editor, trackId), stopPropagation: vi.fn(), clientX: 0, clientY: 0 });
        editor._onGroupDragMove({ clientX: 40, clientY: 25, preventDefault: vi.fn() });
        editor._onGroupDragUp({ clientX: 40, clientY: 25 });

        expect(nodeElTarget(editor, trackId).style.left).toBe('140px');
        expect(nodeElTarget(editor, trackId).style.top).toBe('125px');
        expect(nodeElTarget(editor, delayId).style.left).toBe('340px');
        expect(nodeElTarget(editor, delayId).style.top).toBe('225px');
        expect(editor._multiSelectedNodeIds.size).toBe(2); // the group stays selected after the drag
      });

      it('writes the new positions through to the working graph, so they survive a Save', () => {
        const { editor, trackId } = editorWithSelectedPair();

        editor._onCanvasMouseDown({ button: 0, target: nodeElTarget(editor, trackId), stopPropagation: vi.fn(), clientX: 0, clientY: 0 });
        editor._onGroupDragMove({ clientX: 40, clientY: 25, preventDefault: vi.fn() });
        editor._onGroupDragUp({ clientX: 40, clientY: 25 });

        const track = editor.graph.nodes.find((n) => n.id === trackId);
        expect({ x: track.x, y: track.y }).toEqual({ x: 140, y: 125 });
      });

      it('scales the pointer delta by the current zoom, as a single-node drag does', () => {
        const { editor, trackId } = editorWithSelectedPair();
        editor._drawflow.zoom = 2;

        editor._onCanvasMouseDown({ button: 0, target: nodeElTarget(editor, trackId), stopPropagation: vi.fn(), clientX: 0, clientY: 0 });
        editor._onGroupDragMove({ clientX: 40, clientY: 20, preventDefault: vi.fn() });
        editor._onGroupDragUp({ clientX: 40, clientY: 20 });

        expect(nodeElTarget(editor, trackId).style.left).toBe('120px'); // 100 + 40/2
      });

      it('ignores movement below the click/drag threshold', () => {
        const { editor, trackId } = editorWithSelectedPair();

        editor._onCanvasMouseDown({ button: 0, target: nodeElTarget(editor, trackId), stopPropagation: vi.fn(), clientX: 0, clientY: 0 });
        editor._onGroupDragMove({ clientX: 2, clientY: 2, preventDefault: vi.fn() });

        expect(nodeElTarget(editor, trackId).style.left).toBe('100px');
      });

      it('treats a click with no movement as selecting just that node', () => {
        const { editor, trackId, delayId } = editorWithSelectedPair();

        editor._onCanvasMouseDown({ button: 0, target: nodeElTarget(editor, trackId), stopPropagation: vi.fn(), clientX: 0, clientY: 0 });
        editor._onGroupDragUp({ clientX: 0, clientY: 0 });

        expect(editor.selectedNodeId).toBe(trackId);
        expect(editor._multiSelectedNodeIds.size).toBe(0);
        expect(nodeElTarget(editor, trackId).classList.contains('selected')).toBe(true);
        expect(nodeElTarget(editor, delayId).classList.contains('game-orchestra-multi-selected')).toBe(false);
      });

      it('reapplies a self-loop arc after the drag, which the connection redraw resets', () => {
        const { editor, trackId } = editorWithSelectedPair();
        // Wire the track's exit back to itself, then register its rendered path.
        editor._drawflow._nodes[trackId].outputs.output_1.connections = [{ node: trackId, output: 'input_1' }];
        editor._drawflow._nodes[trackId].inputs.input_1.connections = [{ node: trackId, input: 'output_1' }];
        const pathEl = editor._drawflow.addFakeConnectionPath(trackId, trackId, 'M 100 100 C 150 100 150 200 200 200');

        editor._onCanvasMouseDown({ button: 0, target: nodeElTarget(editor, trackId), stopPropagation: vi.fn(), clientX: 0, clientY: 0 });
        editor._onGroupDragMove({ clientX: 40, clientY: 25, preventDefault: vi.fn() });
        editor._onGroupDragUp({ clientX: 40, clientY: 25 });

        expect(pathEl.getAttribute('d')).not.toBe('M 100 100 C 150 100 150 200 200 200');
      });

      it('unbinds its listeners when the window closes mid-drag', () => {
        const { editor, trackId } = editorWithSelectedPair();
        editor._onCanvasMouseDown({ button: 0, target: nodeElTarget(editor, trackId), stopPropagation: vi.fn(), clientX: 0, clientY: 0 });

        editor._onClose({});

        expect(editor._groupDrag).toBeNull();
        expect(document.removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function));
        expect(document.removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function));
      });
    });

    it("selecting a single node via Drawflow's own nodeSelected event clears any active marquee selection", () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const trackId = editor.graph.nodes.find((n) => n.type === 'track').id;
      editor._multiSelectedNodeIds.add(trackId);
      editor._drawflow.container.querySelector(`#node-${trackId}`).classList.add('game-orchestra-multi-selected');

      editor._drawflow._fire('nodeSelected', trackId);

      expect(editor._multiSelectedNodeIds.size).toBe(0);
      expect(editor._drawflow.container.querySelector(`#node-${trackId}`).classList.contains('game-orchestra-multi-selected')).toBe(false);
    });
  });

  describe('handleApplyPreset', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    /** Mount an editor on a playlist with `soundCount` tracks, ready for a preset. */
    function mountEditor(soundCount = 3) {
      global.Drawflow = createFakeDrawflowClass();
      const sounds = Array.from({ length: soundCount }, (_, i) => createMockSound(`s${i + 1}`, `Track ${i + 1}`));
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', sounds));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      return editor;
    }

    /** A fake <select> target, as the delegated change listener would hand over. */
    function presetTarget(value) {
      return { value, dataset: { changeAction: 'applyPreset' } };
    }

    it('offers every preset, disabling the ones the playlist has too few tracks for', () => {
      const editor = mountEditor(1);
      const presets = editor._prepareContext({}).presets;
      expect(presets.find((p) => p.id === 'single-loop').enabled).toBe(true);
      expect(presets.find((p) => p.id === 'shuffle').enabled).toBe(false);
    });

    it('applies a preset onto a bare Start graph without prompting, and never calls this.render()', async () => {
      const editor = mountEditor(3);
      const renderSpy = vi.spyOn(editor, 'render');
      const target = presetTarget('shuffle');

      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, target);

      expect(foundry.applications.api.DialogV2.confirm).not.toHaveBeenCalled();
      expect(editor.graph.nodes.filter((n) => n.type === 'track')).toHaveLength(3);
      expect(editor.graph.nodes.some((n) => n.type === 'random')).toBe(true);
      expect(renderSpy).not.toHaveBeenCalled();
      expect(target.value).toBe(''); // reset so the same preset can be picked again
    });

    it('confirms before replacing a graph that has more than a Start node', async () => {
      const editor = mountEditor(3);
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });

      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, presetTarget('single-loop'));

      expect(foundry.applications.api.DialogV2.confirm).toHaveBeenCalled();
      expect(editor.graph.nodes.filter((n) => n.type === 'track')).toHaveLength(1);
    });

    it('leaves the canvas untouched when the confirmation is declined', async () => {
      const editor = mountEditor(3);
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'delay' } });
      const before = foundry.utils.deepClone(editor.graph);
      foundry.applications.api.DialogV2.confirm.mockResolvedValueOnce(false);

      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, presetTarget('shuffle'));

      expect(editor.graph).toEqual(before);
    });

    it('drops references to the DOM import() destroyed (selection, marquee, Drawflow node_selected)', async () => {
      const editor = mountEditor(3);
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'track' } });
      const trackId = editor.graph.nodes.find((n) => n.type === 'track').id;
      editor.selectedNodeId = trackId;
      editor._multiSelectedNodeIds.add(trackId);
      editor._drawflow.node_selected = { classList: { remove: vi.fn() } };

      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, presetTarget('sequential-loop'));

      expect(editor.selectedNodeId).toBeNull();
      expect(editor._multiSelectedNodeIds.size).toBe(0);
      expect(editor._drawflow.node_selected).toBeNull();
    });

    it('resyncs the working graph and re-renders node contents after import (no events fire on import)', async () => {
      const editor = mountEditor(2);

      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, presetTarget('layered-ambience'));

      // The graph came back out of Drawflow, not straight from the preset builder.
      expect(editor.graph.nodes.some((n) => n.type === 'fork')).toBe(true);
      for (const node of editor.graph.nodes) {
        expect(editor._drawflow.container.querySelector(`#node-${node.id} .drawflow_content_node`).innerHTML).toContain('game-orchestra-node-content');
      }
      expect(editor.element.inspector.innerHTML).toContain('GameOrchestra.CustomEditor.Inspector.NoSelection');
    });

    it('ignores an unknown preset id and the empty placeholder option', async () => {
      const editor = mountEditor(3);
      const before = foundry.utils.deepClone(editor.graph);

      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, presetTarget(''));
      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, presetTarget('not-a-preset'));

      expect(editor.graph).toEqual(before);
    });
  });

  describe('fixed exits and exit rows', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    /** An editor with one node of `type` mounted, ready for exit manipulation. */
    function editorWithNode(type) {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: type } });
      const nodeId = editor.graph.nodes.find((n) => n.type === type).id;
      editor.selectedNodeId = nodeId;
      return { editor, nodeId };
    }

    const addExit = (editor, nodeId) => CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });
    const removeExit = (editor, nodeId, port) =>
      CustomPlaylistEditor.handleRemoveExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId, port } });
    const exitsOf = (editor, nodeId) => editor._drawflow.getNodeFromId(nodeId).data.exits;

    it("renormalizes the remaining weight chips when a wired Random exit is deleted", () => {
      // Reported live: deleting one of a Random node's three exits left the two
      // survivors' chips reading 33% each. The cause was not the arithmetic - it
      // was that removeNodeOutput() threw partway through (see the fake's
      // updateConnectionNodes), so handleRemoveExit never reached the splice or
      // the refresh below it. The node kept three exits behind two ports, and
      // every later updateConnectionNodes on it threw too.
      const { editor, nodeId } = editorWithNode('random');
      addExit(editor, nodeId);
      addExit(editor, nodeId);
      const targets = [];
      for (let i = 0; i < 3; i++) {
        CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'end' } });
        const targetId = editor.graph.nodes.filter((n) => n.type === 'end').at(-1).id;
        targets.push(targetId);
        editor._drawflow.addConnection(nodeId, targetId, `output_${i + 1}`, 'input_1');
        editor._drawflow.addFakeConnectionPath(nodeId, targetId, 'M0 0 C1 1 2 2 3 3', `output_${i + 1}`);
      }
      editor._syncFromDrawflow(editor._drawflow);
      editor._refreshNodeDisplay(nodeId);
      const chipTexts = () =>
        Object.keys(editor._drawflow.getNodeFromId(nodeId).outputs).map(
          (port) => /(\d+)%/.exec(editor._drawflow.container.querySelector(`#node-${nodeId} .outputs .output.${port}`).innerHTML)?.[1] ?? null
        );
      expect(chipTexts()).toEqual(['33', '33', '33']);

      removeExit(editor, nodeId, 'output_2');

      expect(exitsOf(editor, nodeId)).toHaveLength(2);
      expect(chipTexts()).toEqual(['50', '50']);
      expect(editor.graph.edges.map((e) => e.to)).toEqual([targets[0], targets[2]]);
    });

    it('gives a new Condition node exactly one exit, the fixed fallback', () => {
      const { editor, nodeId } = editorWithNode('condition');
      expect(exitsOf(editor, nodeId)).toEqual([{ condition: { kind: 'default' } }]);
    });

    it('adds new Condition exits BEFORE the fallback, so default stays last', () => {
      const { editor, nodeId } = editorWithNode('condition');

      addExit(editor, nodeId);
      addExit(editor, nodeId);

      const exits = exitsOf(editor, nodeId);
      expect(exits).toHaveLength(3);
      expect(exits.map((e) => e.condition.kind)).toEqual(['combatActive', 'combatActive', 'default']);
    });

    it("moves an already-wired fallback's connection onto the new last port, keeping its target", () => {
      // The alternative - leaving the wire where it is and shuffling metadata
      // around it - would silently hand the fallback's edge to the blank new exit.
      const { editor, nodeId } = editorWithNode('condition');
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'end' } });
      const endId = editor.graph.nodes.find((n) => n.type === 'end').id;
      editor._drawflow.addConnection(nodeId, endId, 'output_1', 'input_1');
      editor._syncFromDrawflow(editor._drawflow);

      addExit(editor, nodeId);

      const live = editor._drawflow.getNodeFromId(nodeId);
      expect(live.outputs.output_1.connections).toEqual([]); // the new, blank exit
      expect(live.outputs.output_2.connections).toEqual([{ node: endId, output: 'input_1' }]); // the fallback, still wired
      expect(live.data.exits[1].condition.kind).toBe('default');
    });

    it('refuses to remove a Condition fallback exit', () => {
      const { editor, nodeId } = editorWithNode('condition');

      removeExit(editor, nodeId, 'output_1');

      expect(exitsOf(editor, nodeId)).toEqual([{ condition: { kind: 'default' } }]);
    });

    it('removes a non-fallback Condition exit normally', () => {
      const { editor, nodeId } = editorWithNode('condition');
      addExit(editor, nodeId);

      removeExit(editor, nodeId, 'output_1');

      expect(exitsOf(editor, nodeId).map((e) => e.condition.kind)).toEqual(['default']);
    });

    it("refuses to remove a Random's last remaining exit, but allows any other", () => {
      const { editor, nodeId } = editorWithNode('random');
      addExit(editor, nodeId);
      expect(exitsOf(editor, nodeId)).toHaveLength(2);

      removeExit(editor, nodeId, 'output_2');
      expect(exitsOf(editor, nodeId)).toHaveLength(1);

      removeExit(editor, nodeId, 'output_1');
      expect(exitsOf(editor, nodeId)).toHaveLength(1); // the fixed one survives
    });

    it('refuses to change the fallback exit\'s kind, or to turn another exit into a second fallback', () => {
      const { editor, nodeId } = editorWithNode('condition');
      addExit(editor, nodeId);

      // exits: [combatActive (output_1), default (output_2)]
      CustomPlaylistEditor.handleUpdateConditionExitKind.call(editor, {}, { value: 'mood', dataset: { nodeId, exitIndex: '1' } });
      CustomPlaylistEditor.handleUpdateConditionExitKind.call(editor, {}, { value: 'default', dataset: { nodeId, exitIndex: '0' } });

      expect(exitsOf(editor, nodeId).map((e) => e.condition.kind)).toEqual(['combatActive', 'default']);
    });

    it('builds one exit row per output PORT, including ports nothing is wired to yet', () => {
      const { editor, nodeId } = editorWithNode('random');
      addExit(editor, nodeId);
      addExit(editor, nodeId);

      const rows = editor._prepareContext({}).selectedExits;

      expect(rows.map((r) => r.portName)).toEqual(['output_1', 'output_2', 'output_3']);
      expect(rows.every((r) => r.weight === 1)).toBe(true);
    });
  });

  describe('hovering an inspector exit row highlights that exit on the canvas', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function editorWithWiredRandom() {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._onRender({}, {});
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'random' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'random').id;
      editor._drawflow.addFakeConnectionPath(nodeId, 'target', 'M0 0 C1 1 2 2 3 3', 'output_1');
      return { editor, nodeId };
    }

    const rowTarget = (nodeId, port) => ({
      closest: (sel) => (sel === '[data-exit-port]' ? { dataset: { nodeId, exitPort: port } } : null)
    });
    const portEl = (editor, nodeId, port) => editor._drawflow.container.querySelector(`#node-${nodeId} .outputs .output.${port}`);
    const edgeEl = (editor) => editor._drawflow._connectionElements[0].el;

    it('highlights the port and, when wired, the edge leaving it', () => {
      const { editor, nodeId } = editorWithWiredRandom();

      editor._onExitHover({ target: rowTarget(nodeId, 'output_1') });

      expect(portEl(editor, nodeId, 'output_1').hasAttribute('data-go-port-hover')).toBe(true);
      expect(edgeEl(editor).hasAttribute('data-go-edge-hover')).toBe(true);
    });

    it('highlights just the port for an exit that is not wired to anything', () => {
      const { editor, nodeId } = editorWithWiredRandom();

      editor._onExitHover({ target: rowTarget(nodeId, 'output_2') });

      expect(portEl(editor, nodeId, 'output_2').hasAttribute('data-go-port-hover')).toBe(true);
      expect(edgeEl(editor).hasAttribute('data-go-edge-hover')).toBe(false);
    });

    it('clears the previous highlight when the pointer moves to another row', () => {
      const { editor, nodeId } = editorWithWiredRandom();

      editor._onExitHover({ target: rowTarget(nodeId, 'output_1') });
      editor._onExitHover({ target: rowTarget(nodeId, 'output_2') });

      expect(portEl(editor, nodeId, 'output_1').hasAttribute('data-go-port-hover')).toBe(false);
      expect(edgeEl(editor).hasAttribute('data-go-edge-hover')).toBe(false);
      expect(portEl(editor, nodeId, 'output_2').hasAttribute('data-go-port-hover')).toBe(true);
    });

    it('clears the highlight when the pointer moves off any row', () => {
      const { editor, nodeId } = editorWithWiredRandom();
      editor._onExitHover({ target: rowTarget(nodeId, 'output_1') });

      editor._onExitHover({ target: { closest: () => null } });

      expect(portEl(editor, nodeId, 'output_1').hasAttribute('data-go-port-hover')).toBe(false);
    });

    it('clears the highlight when the inspector re-renders the row out from under it', () => {
      const { editor, nodeId } = editorWithWiredRandom();
      editor._onExitHover({ target: rowTarget(nodeId, 'output_1') });

      editor._renderInspector();

      expect(editor._hoveredExit).toBeNull();
      expect(portEl(editor, nodeId, 'output_1').hasAttribute('data-go-port-hover')).toBe(false);
    });
  });

  describe('node names', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function mountedEditor() {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      return editor;
    }
    const addNode = (editor, type) => CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: type } });
    const labelOf = (editor, type) => editor.graph.nodes.filter((n) => n.type === type).map((n) => n.label);

    it('names each new node after its type, numbered in creation order', () => {
      const editor = mountedEditor();

      addNode(editor, 'track');
      addNode(editor, 'track');
      addNode(editor, 'delay');

      expect(labelOf(editor, 'track')).toEqual(['Track 1', 'Track 2']);
      expect(labelOf(editor, 'delay')).toEqual(['Delay 1']);
    });

    it('renders the name under the node on the canvas', () => {
      const editor = mountedEditor();
      addNode(editor, 'track');
      const nodeId = editor.graph.nodes.find((n) => n.type === 'track').id;

      expect(editor._drawflow._nodeElements.get(nodeId).innerHTML).toContain('Track 1');
    });

    it('renames a node, and re-renders its caption', () => {
      const editor = mountedEditor();
      addNode(editor, 'track');
      const nodeId = editor.graph.nodes.find((n) => n.type === 'track').id;

      CustomPlaylistEditor.handleUpdateNodeLabel.call(editor, {}, { value: '  Boss Theme  ', dataset: { nodeId } });

      expect(editor.graph.nodes.find((n) => n.id === nodeId).label).toBe('Boss Theme');
      expect(editor._drawflow._nodeElements.get(nodeId).innerHTML).toContain('Boss Theme');
    });

    it('falls back to the type name when the field is cleared, rather than storing a blank', () => {
      const editor = mountedEditor();
      addNode(editor, 'delay');
      const nodeId = editor.graph.nodes.find((n) => n.type === 'delay').id;

      CustomPlaylistEditor.handleUpdateNodeLabel.call(editor, {}, { value: '   ', dataset: { nodeId } });

      expect(editor.graph.nodes.find((n) => n.id === nodeId).label).toBeUndefined();
      expect(editor._drawflow._nodeElements.get(nodeId).innerHTML).toContain('Delay');
    });

    it('gives a pasted node a fresh name instead of duplicating the original', () => {
      const editor = mountedEditor();
      addNode(editor, 'track');
      CustomPlaylistEditor.handleUpdateNodeLabel.call(editor, {}, {
        value: 'Boss Theme',
        dataset: { nodeId: editor.graph.nodes.find((n) => n.type === 'track').id }
      });
      editor.selectedNodeId = editor.graph.nodes.find((n) => n.type === 'track').id;
      editor._copySelection();

      editor._pasteClipboard();

      expect(labelOf(editor, 'track')).toEqual(['Boss Theme', 'Track 1']);
    });

    it('names the offending node in validation output', () => {
      const editor = mountedEditor();
      addNode(editor, 'delay');
      CustomPlaylistEditor.handleUpdateNodeLabel.call(editor, {}, {
        value: 'Breather',
        dataset: { nodeId: editor.graph.nodes.find((n) => n.type === 'delay').id }
      });

      const { validation } = editor._prepareContext({});
      const unreachable = validation.warnings.find((w) => w.messageKey === 'GameOrchestra.CustomEditor.Validation.NodeUnreachable');

      expect(unreachable.nodeLabel).toBe('Breather');
      // Validation moved out of the inspector body into its own pinned region - see
      // docs/graph-editor-panel-plan.md D4.
      expect(editor.element.validation.innerHTML).toContain('<strong>Breather</strong>');
    });
  });

  describe('locating a node from its validation issue', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    /** An editor with an orphaned Delay node (warns "not reachable from Start"). */
    function editorWithOrphan() {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      editor._drawflow.precanvas = { style: { transform: '' } };
      editor._drawflow.container.clientWidth = 800;
      editor._drawflow.container.clientHeight = 600;
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'delay' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'delay').id;
      return { editor, nodeId };
    }
    const badgeOf = (editor, nodeId) => editor._drawflow.container.querySelector(`#node-${nodeId}`).querySelector('.game-orchestra-node-issue');

    it('pans the canvas so the node sits in the middle of the viewport', () => {
      const { editor, nodeId } = editorWithOrphan();
      editor._drawflow._nodes[nodeId].pos_x = 500;
      editor._drawflow._nodes[nodeId].pos_y = 400;

      CustomPlaylistEditor.handleFocusNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId }, closest: () => null });

      // 800/2 - (500 + 130/2) = -165; 600/2 - (400 + 64/2) = -132
      expect(editor._drawflow.canvas_x).toBe(-165);
      expect(editor._drawflow.canvas_y).toBe(-132);
      expect(editor._drawflow.precanvas.style.transform).toBe('translate(-165px, -132px) scale(1)');
    });

    it('accounts for the current zoom when centring', () => {
      const { editor, nodeId } = editorWithOrphan();
      editor._drawflow._nodes[nodeId].pos_x = 500;
      editor._drawflow._nodes[nodeId].pos_y = 400;
      editor._drawflow.zoom = 2;

      editor._focusNode(nodeId);

      expect(editor._drawflow.canvas_x).toBe(400 - 565 * 2);
      expect(editor._drawflow.precanvas.style.transform).toContain('scale(2)');
    });

    it('selects the node it panned to', () => {
      const { editor, nodeId } = editorWithOrphan();

      editor._focusNode(nodeId);

      expect(editor.selectedNodeId).toBe(nodeId);
      expect(editor._drawflow.container.querySelector(`#node-${nodeId}`).classList.contains('selected')).toBe(true);
    });

    it('resolves the node id from the clicked list item, not just the event target', () => {
      const { editor, nodeId } = editorWithOrphan();
      const innerText = { dataset: {}, closest: (sel) => (sel === '[data-node-id]' ? { dataset: { nodeId } } : null) };

      CustomPlaylistEditor.handleFocusNode.call(editor, { preventDefault: vi.fn() }, innerText);

      expect(editor.selectedNodeId).toBe(nodeId);
    });

    it('does nothing for an issue that names no node', () => {
      const { editor } = editorWithOrphan();
      expect(() =>
        CustomPlaylistEditor.handleFocusNode.call(editor, { preventDefault: vi.fn() }, { dataset: {}, closest: () => null })
      ).not.toThrow();
      expect(editor.selectedNodeId).toBeNull();
    });
  });

  describe('validation badges on the canvas', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    /**
     * Start is left unwired, so it errors ("must have exactly one exit") and
     * everything downstream of it warns ("not reachable from Start") - one
     * node of each severity, with a single connection able to clear them all.
     */
    function editorWithIssues() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Theme')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: '3', type: 'end' },
          { id: '4', type: 'delay', delay: { min: 1, max: 1 } }
        ],
        edges: [
          { id: '4:output_1->2', from: '4', to: '2' },
          { id: '2:output_1->3', from: '2', to: '3' }
        ]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      return editor;
    }
    const badgeOf = (editor, nodeId) => editor._drawflow.container.querySelector(`#node-${nodeId}`).querySelector('.game-orchestra-node-issue');

    it('badges a warning node amber, and captions it with the message', () => {
      const editor = editorWithIssues();

      const badge = badgeOf(editor, '4');
      expect(badge.className).toBe('game-orchestra-node-issue game-orchestra-node-issue-warning');
      expect(badge.title).toContain('GameOrchestra.CustomEditor.Validation.NodeUnreachable');
    });

    it('interpolates messageData through game.i18n.format for a message with a placeholder (UnknownNodeType)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: '1', type: 'start' }, { id: '2', type: 'mystery' }],
        edges: [{ id: 'e1', from: '1', to: '2' }]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});

      const badge = badgeOf(editor, '2');
      expect(game.i18n.format).toHaveBeenCalledWith('GameOrchestra.CustomEditor.Validation.UnknownNodeType', { type: 'mystery' });
      expect(badge.title).toContain('mystery');
    });

    it('badges an error node red - an error is what actually blocks saving', () => {
      const editor = editorWithIssues();
      expect(badgeOf(editor, '1').className).toContain('game-orchestra-node-issue-error');
    });

    /**
     * Two Forks wired into each other - the amplifying shape of an
     * instantaneous cycle. The error names every node AND every edge on the
     * loop, because "the graph contains a cycle" is unactionable on a canvas
     * bigger than the viewport.
     */
    function editorWithCycle() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Theme')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'fork' },
          { id: '3', type: 'fork' },
          { id: '4', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: '5', type: 'end' }
        ],
        edges: [
          { id: '1:output_1->2', from: '1', to: '2' },
          { id: '2:output_1->3', from: '2', to: '3' },
          { id: '2:output_2->3', from: '2', to: '3' },
          { id: '3:output_1->2', from: '3', to: '2' },
          { id: '3:output_2->4', from: '3', to: '4' },
          { id: '4:output_1->5', from: '4', to: '5' }
        ]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      for (const edge of editor.graph.edges) {
        editor._drawflow.addFakeConnectionPath(edge.from, edge.to, 'M0,0', /output_\d+/.exec(edge.id)[0]);
      }
      editor._renderInspector();
      return editor;
    }
    const wireMarkers = (editor, edgeId) => {
      const port = /output_\d+/.exec(edgeId)[0];
      const [from, to] = edgeId.split(/:output_\d+->/);
      return editor._drawflow._connectionElements.find((c) => c.outId === from && c.inId === to && c.port === port).el.attrs;
    };

    it('badges every node on an instantaneous cycle, not just the one the issue is anchored to', () => {
      const editor = editorWithCycle();
      expect(badgeOf(editor, '2').className).toContain('game-orchestra-node-issue-error');
      expect(badgeOf(editor, '3').className).toContain('game-orchestra-node-issue-error');
      expect(badgeOf(editor, '2').title).toContain('GameOrchestra.CustomEditor.Validation.InstantaneousCycle');
      expect(badgeOf(editor, '3').title).toContain('GameOrchestra.CustomEditor.Validation.InstantaneousCycle');
    });

    it('colours the wires that form the cycle, and only those', () => {
      const editor = editorWithCycle();
      // The two edges the DFS actually closed the loop through.
      expect(wireMarkers(editor, '2:output_1->3').has('data-go-edge-issue')).toBe(true);
      expect(wireMarkers(editor, '3:output_1->2').has('data-go-edge-issue')).toBe(true);
      // Feeds the loop but isn't on it; leaves the loop but isn't on it.
      expect(wireMarkers(editor, '1:output_1->2').has('data-go-edge-issue')).toBe(false);
      expect(wireMarkers(editor, '3:output_2->4').has('data-go-edge-issue')).toBe(false);
    });

    it('clears the wire colouring once the cycle is broken', () => {
      const editor = editorWithCycle();
      expect(wireMarkers(editor, '2:output_1->3').has('data-go-edge-issue')).toBe(true);

      // Repoint the back-edge at the Track, so nothing closes instantaneously.
      editor.graph.edges = editor.graph.edges.filter((e) => e.id !== '3:output_1->2');
      editor._renderInspector();

      expect(wireMarkers(editor, '2:output_1->3').has('data-go-edge-issue')).toBe(false);
    });

    it('clears the badges once the graph is wired up', () => {
      const editor = editorWithIssues();
      expect(badgeOf(editor, '4')).toBeTruthy();

      editor._drawflow._nodes['1'].outputs.output_1.connections.push({ node: '4', output: 'input_1' });
      editor._drawflow._fire('connectionCreated', { output_id: '1', input_id: '4', output_class: 'output_1', input_class: 'input_1' });

      expect(badgeOf(editor, '1')).toBeNull();
      expect(badgeOf(editor, '4')).toBeNull();
      expect(badgeOf(editor, '2')).toBeNull();
    });

    const nodeElOf = (editor, nodeId) => editor._drawflow.container.querySelector(`#node-${nodeId}`);

    it('colours the whole node, not only its badge, so an invalid graph reads at a glance', () => {
      const editor = editorWithIssues();
      expect(nodeElOf(editor, '1').classList.contains('game-orchestra-node-error')).toBe(true);
      expect(nodeElOf(editor, '4').classList.contains('game-orchestra-node-warning')).toBe(true);
    });

    it('never leaves a node carrying both state classes at once', () => {
      const editor = editorWithIssues();
      expect(nodeElOf(editor, '1').classList.contains('game-orchestra-node-warning')).toBe(false);
      expect(nodeElOf(editor, '4').classList.contains('game-orchestra-node-error')).toBe(false);
    });

    it('strips the state class again once the graph is wired up', () => {
      const editor = editorWithIssues();
      editor._drawflow._nodes['1'].outputs.output_1.connections.push({ node: '4', output: 'input_1' });
      editor._drawflow._fire('connectionCreated', { output_id: '1', input_id: '4', output_class: 'output_1', input_class: 'input_1' });

      expect(nodeElOf(editor, '1').classList.contains('game-orchestra-node-error')).toBe(false);
      expect(nodeElOf(editor, '4').classList.contains('game-orchestra-node-warning')).toBe(false);
    });

    it('gives each severity its own glyph, so the two are not told apart by colour alone', () => {
      const editor = editorWithIssues();
      expect(badgeOf(editor, '1').innerHTML).toContain('fa-xmark');
      expect(badgeOf(editor, '4').innerHTML).toContain('fa-exclamation');
    });

    it('tags the badge with its node id and severity, for the balloon to read back on click', () => {
      const editor = editorWithIssues();
      expect(badgeOf(editor, '4').dataset).toEqual({ nodeId: '4', severity: 'warning' });
    });
  });

  describe('issue balloon (click a node badge to list that node\'s messages)', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function editorWithIssues() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Theme')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: '3', type: 'end' },
          { id: '4', type: 'delay', delay: { min: 1, max: 1 } }
        ],
        edges: [
          { id: '4:output_1->2', from: '4', to: '2' },
          { id: '2:output_1->3', from: '2', to: '3' }
        ]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      return editor;
    }
    const badgeOf = (editor, nodeId) => editor._drawflow.container.querySelector(`#node-${nodeId}`).querySelector('.game-orchestra-node-issue');

    it('opens on a badge click, listing that node\'s messages', () => {
      const editor = editorWithIssues();
      const badge = badgeOf(editor, '4');

      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? badge : null) } });

      expect(editor._issueBalloonNodeId).toBe('4');
      expect(editor._issueBalloonEl.innerHTML).toContain('GameOrchestra.CustomEditor.Validation.NodeUnreachable');
    });

    it('closes again when the same badge is clicked twice', () => {
      const editor = editorWithIssues();
      const badge = badgeOf(editor, '4');
      const click = { target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? badge : null) } };

      editor._onDocumentClick(click);
      editor._onDocumentClick(click);

      expect(editor._issueBalloonNodeId).toBeNull();
      expect(editor._issueBalloonEl).toBeNull();
    });

    it('switches straight to the other node when a different badge is clicked', () => {
      const editor = editorWithIssues();
      const first = badgeOf(editor, '4');
      const second = badgeOf(editor, '1');

      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? first : null) } });
      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? second : null) } });

      expect(editor._issueBalloonNodeId).toBe('1');
    });

    it('dismisses on a click anywhere else', () => {
      const editor = editorWithIssues();
      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? badgeOf(editor, '4') : null) } });

      editor._onDocumentClick({ target: { closest: () => null } });

      expect(editor._issueBalloonNodeId).toBeNull();
    });

    it('survives a click on the balloon itself, so a message can be read or selected', () => {
      const editor = editorWithIssues();
      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? badgeOf(editor, '4') : null) } });

      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-issue-balloon' ? {} : null) } });

      expect(editor._issueBalloonNodeId).toBe('4');
    });

    it('closes on Escape, and swallows the key so the window itself stays open', () => {
      const editor = editorWithIssues();
      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? badgeOf(editor, '4') : null) } });
      const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };

      editor._onEscapeKey(event);

      expect(editor._issueBalloonNodeId).toBeNull();
      expect(event.preventDefault).toHaveBeenCalled();
      expect(event.stopPropagation).toHaveBeenCalled();
    });

    it('leaves Escape alone when no balloon is open, so it still closes the window', () => {
      const editor = editorWithIssues();
      const event = { key: 'Escape', preventDefault: vi.fn(), stopPropagation: vi.fn() };

      editor._onEscapeKey(event);

      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
    });

    it('closes when the canvas is panned or zoomed - it is positioned in screen coordinates', () => {
      const editor = editorWithIssues();
      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? badgeOf(editor, '4') : null) } });

      editor._drawflow._fire('translate', { x: 10, y: 10 });

      expect(editor._issueBalloonNodeId).toBeNull();
    });

    it("closes when the node's issues are resolved out from under it", () => {
      const editor = editorWithIssues();
      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? badgeOf(editor, '4') : null) } });

      editor._drawflow._nodes['1'].outputs.output_1.connections.push({ node: '4', output: 'input_1' });
      editor._drawflow._fire('connectionCreated', { output_id: '1', input_id: '4', output_class: 'output_1', input_class: 'input_1' });

      expect(editor._issueBalloonNodeId).toBeNull();
    });

    it('is torn down on close - it lives on document.body, not inside the window', () => {
      const editor = editorWithIssues();
      editor._onDocumentClick({ target: { closest: (sel) => (sel === '.game-orchestra-node-issue' ? badgeOf(editor, '4') : null) } });

      editor._onClose({});

      expect(editor._issueBalloonEl).toBeNull();
      expect(editor._issueBalloonNodeId).toBeNull();
    });
  });

  describe('zoom-gated node detail', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function mountedEditor() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [{ id: '1', type: 'start' }], edges: [] });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      return editor;
    }

    it('stamps the tier at mount, since the zoom event only fires on a change', () => {
      const editor = mountedEditor();
      expect(editor.element.drawflowCanvas.dataset.zoomTier).toBe('full');
    });

    it("drops to compact from Drawflow's own zoom event, so ctrl+wheel works too", () => {
      const editor = mountedEditor();

      editor._drawflow._fire('zoom', 0.4);

      expect(editor.element.drawflowCanvas.dataset.zoomTier).toBe('compact');
    });

    it('returns to full detail on zooming back in', () => {
      const editor = mountedEditor();
      editor._drawflow._fire('zoom', 0.4);

      editor._drawflow._fire('zoom', 1);

      expect(editor.element.drawflowCanvas.dataset.zoomTier).toBe('full');
    });
  });

  describe('wire routing (wires leave and enter along their port\'s own normal)', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    /** Condition '2' with a branch exit plus its fallback, both on the right-edge stack. */
    function editorWithCondition() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Theme')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'condition' },
          { id: '3', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: '4', type: 'end' }
        ],
        edges: [
          { id: '1:output_1->2', from: '1', to: '2' },
          { id: '2:output_1->3', from: '2', to: '3', condition: { kind: 'combatActive' } },
          { id: '2:output_2->4', from: '2', to: '4', condition: { kind: 'default' } }
        ]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      return editor;
    }

    const coords = (d) => d.match(/-?\d*\.?\d+/g).map(Number);

    // Condition used to be the one type with vertical ports - branches off the
    // bottom edge, fallback off the top. Its exits stack on the RIGHT now, so
    // every output on the canvas leaves the same way. buildRoutedPath still
    // supports 'up'/'down' and its own tests still measure them; nothing in the
    // editor asks for them any more.
    it.each([
      ["a Condition's branch exit", '3', 'output_1'],
      ["a Condition's fallback exit", '4', 'output_2']
    ])('sends %s rightward, like every other output', (_label, target, port) => {
      const editor = editorWithCondition();
      const path = editor._drawflow.addFakeConnectionPath('2', target, 'M 100 50 C 150 50 250 200 300 200', port);

      editor._routeConnections('2');

      const c = coords(path.getAttribute('d'));
      // First straight run leaves straight RIGHT: same Y, greater X.
      expect(c[2]).toBeGreaterThan(100);
      expect(c[3]).toBe(50);
    });

    it('sends an ordinary output rightward', () => {
      const editor = editorWithCondition();
      const path = editor._drawflow.addFakeConnectionPath('1', '2', 'M 10 20 C 50 20 150 90 200 90', 'output_1');

      editor._routeConnections('1');

      const c = coords(path.getAttribute('d'));
      expect(c[2]).toBeGreaterThan(10);
      expect(c[3]).toBe(20);
    });

    it('preserves the endpoints Drawflow measured - only the curve between them is ours', () => {
      const editor = editorWithCondition();
      const path = editor._drawflow.addFakeConnectionPath('1', '2', 'M 10 20 C 50 20 150 90 200 90', 'output_1');

      editor._routeConnections('1');

      const c = coords(path.getAttribute('d'));
      expect([c[0], c[1]]).toEqual([10, 20]);
      expect([c[c.length - 2], c[c.length - 1]]).toEqual([200, 90]);
    });

    it('is idempotent - routing an already-routed wire keeps the same endpoints', () => {
      const editor = editorWithCondition();
      const path = editor._drawflow.addFakeConnectionPath('1', '2', 'M 10 20 C 50 20 150 90 200 90', 'output_1');

      editor._routeConnections('1');
      const once = path.getAttribute('d');
      editor._routeConnections('1');

      expect(path.getAttribute('d')).toBe(once);
    });

    it('leaves a self-loop alone - its own clearing arc owns that path', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Theme')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: '1', type: 'start' }, { id: '2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: '2:output_1->2', from: '2', to: '2' }]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      const path = editor._drawflow.addFakeConnectionPath('2', '2', 'M 10 50 C 30 50 70 50 90 50', 'output_1');

      editor._routeConnections('2');

      // Untouched by the router - no straight stub segment was introduced.
      expect(path.getAttribute('d')).not.toContain(' L ');
    });

    it('reapplies on every frame of a drag, not only when the mouse is released', () => {
      const editor = editorWithCondition();
      const path = editor._drawflow.addFakeConnectionPath('1', '2', 'M 10 20 C 50 20 150 90 200 90', 'output_1');
      editor._drawflow.drag = true;
      editor._drawflow.ele_selected = { id: 'node-1' };

      editor._drawflow._fire('mouseMove', { x: 0, y: 0 });

      expect(path.getAttribute('d')).toContain(' L ');
    });

    it("re-routes the TARGET node's other wires too, not just the source's (regression: connecting a wire re-oriented an unrelated one, and only moving the block fixed it)", () => {
      const editor = editorWithCondition();
      // An existing wire out of the Condition's fallback port, already routed.
      const existing = editor._drawflow.addFakeConnectionPath('2', '4', 'M 100 50 C 150 50 250 200 300 200', 'output_2');
      editor._routeConnections('2');
      expect(existing.getAttribute('d')).toContain(' L ');

      // Now something else is wired INTO the Condition. Drawflow calls
      // updateConnectionNodes() for both endpoints, which redraws every wire
      // touching either of them back to its own default curve - including the
      // untouched one above. Stand in for that reset, then fire the event.
      existing.setAttribute('d', 'M 100 50 C 150 50 250 200 300 200');
      editor._drawflow._fire('connectionCreated', { output_id: '1', input_id: '2', output_class: 'output_1', input_class: 'input_1' });

      expect(existing.getAttribute('d')).toContain(' L ');
      // Still leaving along its port's own normal, not on Drawflow's own curve.
      const c = coords(existing.getAttribute('d'));
      expect(c[2]).toBeGreaterThan(100);
      expect(c[3]).toBe(50);
    });

    it('does the same on disconnect, which resets the very same wires', () => {
      const editor = editorWithCondition();
      const existing = editor._drawflow.addFakeConnectionPath('2', '4', 'M 100 50 C 150 50 250 200 300 200', 'output_2');

      editor._drawflow._fire('connectionRemoved', { output_id: '1', input_id: '2', output_class: 'output_1', input_class: 'input_1' });

      expect(existing.getAttribute('d')).toContain(' L ');
    });

    it('does nothing on a plain mouse move that is not a drag', () => {
      const editor = editorWithCondition();
      const path = editor._drawflow.addFakeConnectionPath('1', '2', 'M 10 20 C 50 20 150 90 200 90', 'output_1');
      editor._drawflow.drag = false;
      editor._drawflow.ele_selected = { id: 'node-1' };

      editor._drawflow._fire('mouseMove', { x: 0, y: 0 });

      expect(path.getAttribute('d')).not.toContain(' L ');
    });
  });

  describe('uncertain wires (edges leaving a Random or Condition node)', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function editorWithBranches() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Theme')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'random' },
          { id: '3', type: 'fork' },
          { id: '4', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: '1:output_1->2', from: '1', to: '2' },
          { id: '2:output_1->4', from: '2', to: '4' },
          { id: '3:output_1->4', from: '3', to: '4' }
        ]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      return editor;
    }

    const hasUncertain = (editor, outId) =>
      editor._drawflow._connectionElements.find((c) => c.outId === outId).el.hasAttribute('data-go-edge-uncertain');

    it("marks a Random's wires and leaves a Fork's alone - a Fork takes every exit at once", () => {
      const editor = editorWithBranches();
      editor._onRender({}, {});
      editor._drawflow.addFakeConnectionPath('2', '4', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._drawflow.addFakeConnectionPath('3', '4', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');

      editor._refreshUncertainEdges();

      expect(hasUncertain(editor, '2')).toBe(true);
      expect(hasUncertain(editor, '3')).toBe(false);
      expect(hasUncertain(editor, '1')).toBe(false);
    });

    it('clears the class from a wire that is no longer uncertain, rather than only ever adding', () => {
      const editor = editorWithBranches();
      editor._onRender({}, {});
      editor._drawflow.addFakeConnectionPath('2', '4', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._refreshUncertainEdges();
      expect(hasUncertain(editor, '2')).toBe(true);

      // The same wire, now leaving a node that takes every one of its exits.
      editor.graph.nodes.find((n) => n.id === '2').type = 'fork';
      editor._refreshUncertainEdges();

      expect(hasUncertain(editor, '2')).toBe(false);
    });

    it('reapplies after a new connection, which Drawflow draws as a brand-new SVG', () => {
      const editor = editorWithBranches();
      editor._onRender({}, {});
      const path = editor._drawflow.addFakeConnectionPath('2', '4', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      expect(path).toBeTruthy();

      editor._drawflow._fire('connectionCreated', { output_id: '2', input_id: '4', output_class: 'output_1', input_class: 'input_1' });

      expect(hasUncertain(editor, '2')).toBe(true);
    });
  });

  describe('tucked-in ports (revealed when the wire touching them is hovered)', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function wiredEditor() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Theme')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: '3', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: '1:output_1->2', from: '1', to: '2' },
          { id: '2:output_1->3', from: '2', to: '3' }
        ]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      return editor;
    }

    const revealed = (editor, key) => Boolean(editor._drawflow._portElements.get(key)?.hasAttribute?.('data-go-port-revealed'));

    it('reveals the ports at BOTH ends of the hovered wire', () => {
      const editor = wiredEditor();
      const wire = editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');

      editor._onWireHover({ target: { closest: (sel) => (sel === '.connection' ? editor._drawflow._connectionElements[0].el : null) } });

      expect(revealed(editor, '1:output_1')).toBe(true);
      expect(revealed(editor, '2:input_1')).toBe(true);
      expect(wire).toBeTruthy();
    });

    it('leaves every other port tucked in', () => {
      const editor = wiredEditor();
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._drawflow.addFakeConnectionPath('2', '3', 'M 0 0 C 0 0 0 0 0 0', 'output_1');

      editor._setHoveredWire(editor._drawflow._connectionElements[0].el);

      expect(revealed(editor, '3:input_1')).toBe(false);
    });

    it('un-reveals when the pointer moves off the wire onto bare canvas', () => {
      const editor = wiredEditor();
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._setHoveredWire(editor._drawflow._connectionElements[0].el);

      editor._onWireHover({ target: { closest: () => null } });

      expect(revealed(editor, '1:output_1')).toBe(false);
      expect(revealed(editor, '2:input_1')).toBe(false);
    });

    it('hands the reveal over when the pointer crosses straight from one wire to another', () => {
      const editor = wiredEditor();
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._drawflow.addFakeConnectionPath('2', '3', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._setHoveredWire(editor._drawflow._connectionElements[0].el);

      editor._setHoveredWire(editor._drawflow._connectionElements[1].el);

      expect(revealed(editor, '1:output_1')).toBe(false);
      expect(revealed(editor, '3:input_1')).toBe(true);
    });

    it("ignores the bare in-progress wire Drawflow draws while you're dragging one out", () => {
      const editor = wiredEditor();
      const bare = { classList: new Set(['connection']) };

      expect(() => editor._setHoveredWire(bare)).not.toThrow();
      expect(revealed(editor, '1:output_1')).toBe(false);
    });

    it('still un-reveals after Drawflow has discarded the hovered wire mid-hover', () => {
      // Deleting a wire detaches its <svg> while the pointer is still on it.
      // The stale element keeps its own endpoint classes, which is exactly what
      // the cleanup reads - the ports themselves are still in the document.
      const editor = wiredEditor();
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      const stale = editor._drawflow._connectionElements[0].el;
      editor._setHoveredWire(stale);
      editor._drawflow._connectionElements.length = 0;

      editor._setHoveredWire(null);

      expect(revealed(editor, '1:output_1')).toBe(false);
      expect(revealed(editor, '2:input_1')).toBe(false);
    });

    it('drops the stale hover when a connection change rebuilds the wire SVGs', () => {
      const editor = wiredEditor();
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._setHoveredWire(editor._drawflow._connectionElements[0].el);

      editor._drawflow._fire('connectionCreated', { output_id: '1', input_id: '2', output_class: 'output_1', input_class: 'input_1' });

      expect(editor._hoveredWire).toBeNull();
      expect(revealed(editor, '1:output_1')).toBe(false);
    });

    it("reveals the far end of a highlighted exit, so an inspector row shows where its wire lands", () => {
      const editor = wiredEditor();
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');

      editor._setHoveredExit('1', 'output_1');

      expect(revealed(editor, '2:input_1')).toBe(true);
    });

    it('takes that reveal back when the inspector row is no longer hovered', () => {
      const editor = wiredEditor();
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      editor._setHoveredExit('1', 'output_1');

      editor._setHoveredExit(null, null);

      expect(revealed(editor, '2:input_1')).toBe(false);
    });

    it('drives both hover highlights off the one delegated listener', () => {
      const editor = wiredEditor();
      editor._drawflow.addFakeConnectionPath('1', '2', 'M 0 0 C 0 0 0 0 0 0', 'output_1');
      const wireEl = editor._drawflow._connectionElements[0].el;

      editor._onWindowHoverHandler({ target: { closest: (sel) => (sel === '.connection' ? wireEl : null) } });
      expect(revealed(editor, '2:input_1')).toBe(true);

      editor._onWindowHoverLeaveHandler();
      expect(revealed(editor, '2:input_1')).toBe(false);
      expect(editor._hoveredExit).toBeNull();
    });
  });

  // Condition's branch exits moved from the bottom edge to a right-edge stack:
  // spread along the bottom, exit chips collided with each other and buried the
  // name caption, and the fallback - which validation requires to be evaluated
  // LAST - sat at the top, reading first.
  describe('Condition node exit stack', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function conditionEditor() {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      CustomPlaylistEditor.handleAddNode.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeType: 'condition' } });
      const nodeId = editor.graph.nodes.find((n) => n.type === 'condition').id;
      return { editor, nodeId };
    }
    const portEl = (editor, nodeId, port) => editor._drawflow.container.querySelector(`#node-${nodeId} .outputs .output.${port}`);

    it('grows taller as branches are added, and never sets an inline width', () => {
      const { editor, nodeId } = conditionEditor();
      const nodeEl = editor._drawflow.container.querySelector(`#node-${nodeId}`);
      expect(nodeEl.style.height).toBe('64px');
      expect(nodeEl.style.width).toBeFalsy();

      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });
      expect(nodeEl.style.height).toBe('90px');
      expect(nodeEl.style.width).toBeFalsy();
    });

    it('no longer tags ports for a bottom/top edge - every output faces right now', () => {
      const { editor, nodeId } = conditionEditor();
      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });

      for (const port of ['output_1', 'output_2']) {
        expect(portEl(editor, nodeId, port).classList.contains('game-orchestra-exit-branch')).toBe(false);
        expect(portEl(editor, nodeId, port).classList.contains('game-orchestra-exit-default')).toBe(false);
      }
    });

    it('keeps the fallback on the LAST port, so top-to-bottom reads as evaluation order', () => {
      const { editor, nodeId } = conditionEditor();
      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });
      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });

      const exits = editor._liveNode(nodeId).data.exits;
      expect(exits.at(-1).condition.kind).toBe('default');
      expect(portEl(editor, nodeId, 'output_3').innerHTML).toContain('GameOrchestra.CustomEditor.ExitChip.Default');
    });
  });

  // Channel 4: the per-exit guard, written into the port element itself.
  describe('exit chips on the canvas', () => {
    afterEach(() => {
      delete global.Drawflow;
    });

    function editorWith(type) {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Battle')]));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const nodeId = editor._addNodeOfType(type);
      return { editor, nodeId };
    }
    const chipOf = (editor, nodeId, port) => editor._drawflow.container.querySelector(`#node-${nodeId} .outputs .output.${port}`).innerHTML;

    it("renders a Random exit's share of the total weight", () => {
      const { editor, nodeId } = editorWith('random');
      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, { dataset: { nodeId } });
      const node = editor._liveNode(nodeId);
      node.data.exits = [{ weight: 3, cooldown: 0 }, { weight: 1, cooldown: 0 }];
      editor._patchNodeData(nodeId, node.data);

      expect(chipOf(editor, nodeId, 'output_1')).toContain('75%');
      expect(chipOf(editor, nodeId, 'output_2')).toContain('25%');
    });

    it('leaves a Fork exit unchipped - every exit fires, so there is no guard to state', () => {
      const { editor, nodeId } = editorWith('fork');
      expect(chipOf(editor, nodeId, 'output_1')).toBe('');
    });

    it("chips an until-Track's single exit with its escape condition", () => {
      const { editor, nodeId } = editorWith('track');
      const node = editor._liveNode(nodeId);
      node.data.loop = { mode: 'until', condition: { kind: 'combatIdle' }, boundary: 'immediate', minLoops: 1, maxLoops: null };
      editor._patchNodeData(nodeId, node.data);

      expect(chipOf(editor, nodeId, 'output_1')).toContain('GameOrchestra.CustomEditor.ExitChip.CombatIdle');
    });

    // The chip has to be CLEARED, not just written: an exit that loses its
    // guard would otherwise keep showing the old one indefinitely.
    it('clears a stale chip when the exit stops being guarded', () => {
      const { editor, nodeId } = editorWith('track');
      const node = editor._liveNode(nodeId);
      node.data.loop = { mode: 'until', condition: { kind: 'combatIdle' }, minLoops: 1, maxLoops: null };
      editor._patchNodeData(nodeId, node.data);
      expect(chipOf(editor, nodeId, 'output_1')).not.toBe('');

      const back = editor._liveNode(nodeId);
      back.data.loop = { mode: 'count', count: 1 };
      editor._patchNodeData(nodeId, back.data);

      expect(chipOf(editor, nodeId, 'output_1')).toBe('');
    });

    it('does not throw when the canvas is not mounted', () => {
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));
      expect(() => editor._refreshExitChips({ type: 'random' }, '1', null)).not.toThrow();
    });
  });

  describe('drain overlay', () => {
    afterEach(() => {
      delete global.Drawflow;
      vi.useRealTimers();
    });

    function delayEditor() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: '1', type: 'start' }, { id: '2', type: 'delay', delay: { min: 4, max: 4 } }],
        edges: [{ id: '1:output_1->2', from: '1', to: '2' }]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      return editor;
    }
    const levelEl = (editor, nodeId = '2') => editor._drawflow.container.querySelector(`#node-${nodeId} .game-orchestra-node-fill-level`);

    it('runs the drain for the wait\'s real duration', () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const editor = delayEditor();

      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2'],
        activeTimings: [{ nodeId: '2', durationMs: 4000, startedAt: 10_000 }]
      });

      expect(levelEl(editor).style.animation).toBe('game-orchestra-delay-drain 4000ms linear 0ms 1 forwards');
    });

    it('picks the drain up partway through for an editor opened mid-wait', () => {
      vi.useFakeTimers();
      vi.setSystemTime(13_000);
      const editor = delayEditor();

      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2'],
        activeTimings: [{ nodeId: '2', durationMs: 4000, startedAt: 10_000 }]
      });

      // A negative delay starts it 3s in, with 1s of drain left.
      expect(levelEl(editor).style.animation).toBe('game-orchestra-delay-drain 4000ms linear -3000ms 1 forwards');
    });

    it('stops the drain when the delay elapses', () => {
      const editor = delayEditor();
      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2'],
        activeTimings: [{ nodeId: '2', durationMs: 4000, startedAt: Date.now() }]
      });

      Hooks.callAll('gameOrchestraGraphActivity', { playlistId: 'pl1', activeNodeIds: [], activeTimings: [] });

      expect(levelEl(editor).style.animation).toBe('');
    });

    /** start -> track(s1) -> delay, so both drain types are on one canvas. */
    function trackEditor() {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Theme')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 3 } },
          { id: '3', type: 'delay', delay: { min: 4, max: 4 } }
        ],
        edges: [
          { id: '1:output_1->2', from: '1', to: '2' },
          { id: '2:output_1->3', from: '2', to: '3' }
        ]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      return editor;
    }

    it('sweeps a Track node sideways, once per loop iteration', () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const editor = trackEditor();

      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2'],
        activeTimings: [{ nodeId: '2', durationMs: 30_000, startedAt: 10_000, iterations: 3 }]
      });

      // The track's own keyframes, not the delay's - they animate different axes.
      expect(levelEl(editor).style.animation).toBe('game-orchestra-track-drain 30000ms linear 0ms 3 forwards');
    });

    it('repeats indefinitely for a track that loops until something stops it', () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const editor = trackEditor();

      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2'],
        activeTimings: [{ nodeId: '2', durationMs: 30_000, startedAt: 10_000, iterations: null }]
      });

      expect(levelEl(editor).style.animation).toBe('game-orchestra-track-drain 30000ms linear 0ms infinite forwards');
    });

    it('picks a looping track up mid-sweep, several iterations in', () => {
      vi.useFakeTimers();
      vi.setSystemTime(85_000);
      const editor = trackEditor();

      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2'],
        activeTimings: [{ nodeId: '2', durationMs: 30_000, startedAt: 10_000, iterations: null }]
      });

      // 75s in: two whole passes plus 15s, and the negative delay carries all of
      // it - the browser resolves which iteration that lands in.
      expect(levelEl(editor).style.animation).toBe('game-orchestra-track-drain 30000ms linear -75000ms infinite forwards');
    });

    it('survives an inspector edit to the node it is running on', () => {
      // Reported live: editing any field on a playing Track node made its
      // progress fill vanish. _refreshNodeDisplay() replaces the node's content
      // wholesale, drain overlay included, and nothing would repaint it until
      // the engine's next broadcast - a whole track away.
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const editor = trackEditor();
      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2'],
        activeTimings: [{ nodeId: '2', durationMs: 30_000, startedAt: 10_000, iterations: null }]
      });

      vi.setSystemTime(22_000);
      CustomPlaylistEditor.handleUpdateTrackLoopCount.call(editor, {}, { value: '5', dataset: { nodeId: '2' } });

      // Resumed where it actually is (12s in), not restarted from full.
      expect(levelEl(editor).style.animation).toBe('game-orchestra-track-drain 30000ms linear -12000ms infinite forwards');
    });

    it('leaves a node with no countdown alone when its content is rebuilt', () => {
      vi.useFakeTimers();
      const editor = trackEditor();
      CustomPlaylistEditor.handleUpdateTrackLoopCount.call(editor, {}, { value: '5', dataset: { nodeId: '2' } });

      expect(levelEl(editor).style.animation).toBe('');
    });

    it('drives a Track and a Delay at once, each with its own keyframes', () => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      const editor = trackEditor();

      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2', '3'],
        activeTimings: [
          { nodeId: '2', durationMs: 30_000, startedAt: 10_000, iterations: 1 },
          { nodeId: '3', durationMs: 4000, startedAt: 10_000, iterations: 1 }
        ]
      });

      expect(levelEl(editor, '2').style.animation).toContain('game-orchestra-track-drain');
      expect(levelEl(editor, '3').style.animation).toContain('game-orchestra-delay-drain');
    });
  });

  describe('live playback highlight', () => {
    afterEach(() => {
      delete global.Drawflow;
      vi.useRealTimers();
    });

    /** An editor whose stored graph is start -> t1 -> t2 -> t1, mounted and rendered. */
    function mountPlayingEditor() {
      global.Drawflow = createFakeDrawflowClass();
      const sounds = [createMockSound('s1', 'Track 1'), createMockSound('s2', 'Track 2')];
      const playlist = createMockPlaylist('pl1', 'Playlist', sounds);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [
          { id: '1', type: 'start' },
          { id: '2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } },
          { id: '3', type: 'track', soundId: 's2', loop: { mode: 'count', count: 1 } }
        ],
        edges: [
          { id: '1:output_1->2', from: '1', to: '2' },
          { id: '2:output_1->3', from: '2', to: '3' },
          { id: '3:output_1->2', from: '3', to: '2' }
        ]
      });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._onRender({}, {});
      // Register the rendered wires the highlight will look for.
      editor._drawflow.addFakeConnectionPath('2', '3', 'M0 0 C1 1 2 2 3 3', 'output_1');
      editor._drawflow.addFakeConnectionPath('1', '2', 'M0 0 C1 1 2 2 3 3', 'output_1');
      return editor;
    }

    const nodeHasClass = (editor, id, cls) => editor._drawflow.container.querySelector(`#node-${id}`).classList.contains(cls);
    const edgeHasMarker = (editor, outId, inId, attr) =>
      editor._drawflow._connectionElements.find((c) => c.outId === outId && c.inId === inId).el.hasAttribute(attr);

    it('subscribes to engine activity on render and unsubscribes on close', () => {
      const editor = mountPlayingEditor();
      expect(editor._activityHookId).not.toBeNull();
      expect(Hooks._listeners.get('gameOrchestraGraphActivity')).toHaveLength(1);

      editor._onClose({});

      expect(editor._activityHookId).toBeNull();
      expect(Hooks._listeners.get('gameOrchestraGraphActivity')).toHaveLength(0);
    });

    it('highlights the active node and its known exit edge when the engine broadcasts', () => {
      const editor = mountPlayingEditor();

      Hooks.callAll('gameOrchestraGraphActivity', { playlistId: 'pl1', activeNodeIds: ['2'], enteredNodeId: '2', traversedEdgeIds: [] });

      expect(nodeHasClass(editor, '2', 'game-orchestra-node-active')).toBe(true);
      expect(edgeHasMarker(editor, '2', '3', 'data-go-edge-active')).toBe(true);
    });

    it('moves the highlight as the token advances, leaving nothing behind on the old node', () => {
      const editor = mountPlayingEditor();

      Hooks.callAll('gameOrchestraGraphActivity', { playlistId: 'pl1', activeNodeIds: ['2'], traversedEdgeIds: [] });
      Hooks.callAll('gameOrchestraGraphActivity', { playlistId: 'pl1', activeNodeIds: ['3'], traversedEdgeIds: [] });

      expect(nodeHasClass(editor, '2', 'game-orchestra-node-active')).toBe(false);
      expect(nodeHasClass(editor, '3', 'game-orchestra-node-active')).toBe(true);
      expect(edgeHasMarker(editor, '2', '3', 'data-go-edge-active')).toBe(false);
    });

    it('flashes an instantaneous node and clears the flash on its own, keeping the active glow', () => {
      vi.useFakeTimers();
      const editor = mountPlayingEditor();

      Hooks.callAll('gameOrchestraGraphActivity', {
        playlistId: 'pl1',
        activeNodeIds: ['2'],
        enteredNodeId: '1',
        traversedEdgeIds: ['1:output_1->2']
      });
      expect(nodeHasClass(editor, '1', 'game-orchestra-node-pulse')).toBe(true);
      expect(edgeHasMarker(editor, '1', '2', 'data-go-edge-pulse')).toBe(true);

      vi.advanceTimersByTime(1000);

      expect(nodeHasClass(editor, '1', 'game-orchestra-node-pulse')).toBe(false);
      expect(edgeHasMarker(editor, '1', '2', 'data-go-edge-pulse')).toBe(false);
      expect(nodeHasClass(editor, '2', 'game-orchestra-node-active')).toBe(true); // persistent part survives
    });

    it('ignores activity broadcast for a different playlist', () => {
      const editor = mountPlayingEditor();

      Hooks.callAll('gameOrchestraGraphActivity', { playlistId: 'other', activeNodeIds: ['2'], traversedEdgeIds: [] });

      expect(nodeHasClass(editor, '2', 'game-orchestra-node-active')).toBe(false);
    });

    it('clears the highlight when playback stops (empty active set)', () => {
      const editor = mountPlayingEditor();
      Hooks.callAll('gameOrchestraGraphActivity', { playlistId: 'pl1', activeNodeIds: ['2'], traversedEdgeIds: [] });

      Hooks.callAll('gameOrchestraGraphActivity', { playlistId: 'pl1', activeNodeIds: [], traversedEdgeIds: [] });

      expect(nodeHasClass(editor, '2', 'game-orchestra-node-active')).toBe(false);
      expect(edgeHasMarker(editor, '2', '3', 'data-go-edge-active')).toBe(false);
    });

    it('primes itself from an engine already playing when the window opens', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Track 1')]);
      playlist.setFlag('game-orchestra', 'customPlayback', {
        version: 1,
        nodes: [{ id: '1', type: 'start' }, { id: '2', type: 'track', soundId: 's1', loop: { mode: 'count', count: 1 } }],
        edges: [{ id: '1:output_1->2', from: '1', to: '2' }]
      });
      game.gameOrchestra.musicController = {
        getGraphActivity: vi.fn(() => ({ playlistId: 'pl1', activeNodeIds: ['2'], enteredNodeId: null, traversedEdgeIds: [] }))
      };
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();

      editor._onRender({}, {});

      expect(game.gameOrchestra.musicController.getGraphActivity).toHaveBeenCalledWith(playlist);
      expect(nodeHasClass(editor, '2', 'game-orchestra-node-active')).toBe(true);
    });

    it('does not paint anything when no engine is running for this playlist', () => {
      const editor = mountPlayingEditor(); // musicController mock has no getGraphActivity
      expect(editor._activityHighlight).toEqual({ activeNodeIds: [], pulseNodeIds: [], activeEdges: [], pulseEdges: [], activeTimings: [] });
    });

    it('never re-renders the application while updating the highlight (the dragging regression)', () => {
      const editor = mountPlayingEditor();
      const renderSpy = vi.spyOn(editor, 'render');

      Hooks.callAll('gameOrchestraGraphActivity', { playlistId: 'pl1', activeNodeIds: ['2'], enteredNodeId: '1', traversedEdgeIds: [] });

      expect(renderSpy).not.toHaveBeenCalled();
    });
  });

  describe('accordion panel (docs/graph-editor-panel-plan.md)', () => {
    function editorWithPanes() {
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      return editor;
    }

    /** Every pane id that is currently expanded, in template order. */
    function openPanes(editor) {
      return Object.entries(editor.element.panes)
        .filter(([, pane]) => !pane.classList.contains('game-orchestra-collapsed'))
        .map(([id]) => id);
    }

    it('expanding a pane collapses every other one - the panel is single-open', () => {
      const editor = editorWithPanes();
      const { palette, properties } = editor.element.panes;
      expect(openPanes(editor)).toEqual(['properties']); // the fake mirrors the template's start state

      CustomPlaylistEditor.handleTogglePane.call(editor, { preventDefault: vi.fn() }, palette);

      expect(openPanes(editor)).toEqual(['palette']);
      expect(palette.header._ariaExpanded).toBe('true');
      expect(properties.header._ariaExpanded).toBe('false');
    });

    it('toggling the OPEN pane closes it, leaving none open - the deliberate escape hatch that hands the column to validation', () => {
      const editor = editorWithPanes();
      const { properties } = editor.element.panes;

      CustomPlaylistEditor.handleTogglePane.call(editor, { preventDefault: vi.fn() }, properties);

      expect(openPanes(editor)).toEqual([]);
      expect(properties.header._ariaExpanded).toBe('false');
    });

    it('toggling the same pane twice returns it to its original state', () => {
      const editor = editorWithPanes();
      const { tracks } = editor.element.panes;

      CustomPlaylistEditor.handleTogglePane.call(editor, { preventDefault: vi.fn() }, tracks);
      CustomPlaylistEditor.handleTogglePane.call(editor, { preventDefault: vi.fn() }, tracks);

      expect(openPanes(editor)).toEqual([]);
      expect(tracks.header._ariaExpanded).toBe('false');
    });

    it('_setPaneCollapsed(id, true) collapses only the named pane - it must not disturb whatever else is open', () => {
      const editor = editorWithPanes();

      editor._setPaneCollapsed('palette', true);

      expect(openPanes(editor)).toEqual(['properties']);
    });

    it('selecting a node on the canvas expands the Properties pane, collapsing whichever pane was open', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = editorWithPanes();
      editor._setPaneCollapsed('tracks', false); // user was working in Tracks
      editor._mountDrawflow();
      const nodeId = editor._drawflow.addNode('track', 1, 1, 0, 0, 'game-orchestra-node-track', { soundId: null, loop: { mode: 'count', count: 1 } }, 'track');

      editor._drawflow._fire('nodeSelected', nodeId);

      expect(openPanes(editor)).toEqual(['properties']);
      delete global.Drawflow;
    });

    it('_selectSingleNode (used by rect-select/group-drag) also expands Properties', () => {
      global.Drawflow = createFakeDrawflowClass();
      const editor = editorWithPanes();
      editor._setPaneCollapsed('palette', false);
      editor._mountDrawflow();
      const nodeId = editor._drawflow.addNode('track', 1, 1, 0, 0, 'game-orchestra-node-track', { soundId: null, loop: { mode: 'count', count: 1 } }, 'track');

      editor._selectSingleNode(nodeId);

      expect(openPanes(editor)).toEqual(['properties']);
      delete global.Drawflow;
    });

    it('DRAGGING a track in does not steal the open pane - only clicking a node does', () => {
      global.Drawflow = createFakeDrawflowClass();
      const s1 = createMockSound('s1', 'Battle Theme');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1]);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._setPaneCollapsed('tracks', false);
      editor._mountDrawflow();

      // The drop path (_onDropExternal) and the Tracks pane's "+" both land here, and neither
      // selects the new node - so the user stays in Tracks and can drag the next one straight in.
      editor._addNodeOfType('track', { soundId: 's1' });

      expect(openPanes(editor)).toEqual(['tracks']);
      delete global.Drawflow;
    });
  });

  describe('_addNodeOfType / Tracks pane "+" button / default placement (docs/graph-editor-panel-plan.md D6/D7)', () => {
    it('handleAddTrackNode creates a track node preset with the given sound already selected', () => {
      global.Drawflow = createFakeDrawflowClass();
      const s1 = createMockSound('s1', 'Track One');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1]);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      CustomPlaylistEditor.handleAddTrackNode.call(editor, { preventDefault: vi.fn() }, { dataset: { soundId: 's1' } });

      const trackNode = editor.graph.nodes.find((n) => n.type === 'track');
      expect(trackNode).toBeTruthy();
      expect(trackNode.soundId).toBe('s1');
      delete global.Drawflow;
    });

    it('handleAddTrackNode does nothing without a sound id (a stale/malformed button)', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      const before = editor.graph.nodes.length;

      CustomPlaylistEditor.handleAddTrackNode.call(editor, { preventDefault: vi.fn() }, { dataset: {} });

      expect(editor.graph.nodes.length).toBe(before);
      delete global.Drawflow;
    });

    it('_defaultNodePoint cascades on successive calls so repeated adds do not stack on the exact same pixel', () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();

      const p1 = editor._defaultNodePoint();
      const p2 = editor._defaultNodePoint();

      expect(p2.x).not.toBe(p1.x);
      expect(p2.y).not.toBe(p1.y);
      delete global.Drawflow;
    });
  });

  describe('drag-in from the sidebar / Tracks pane (docs/graph-editor-panel-plan.md D8)', () => {
    function editorWithSound() {
      global.Drawflow = createFakeDrawflowClass();
      const s1 = createMockSound('s1', 'Track One');
      const playlist = createMockPlaylist('pl1', 'Playlist', [s1]);
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      return editor;
    }

    afterEach(() => {
      delete global.Drawflow;
      delete global.fromUuid;
    });

    // CONFIRMED LIVE: dragging a track onto the canvas worked exactly once, then silently stopped
    // - no console error. Foundry's DragDrop#bind() is not delegated (see the MockDragDrop
    // docstring): it attaches dragstart to the rows matching dragSelector at call time, and
    // _renderTracks() replaces every one of those rows on each inspector refresh.
    it('rebinds dragstart onto the rows _renderTracks() just created, not only the ones present at first render', () => {
      const editor = editorWithSound();

      editor._renderTracks();
      const firstRows = editor.element.tracks.rows;
      expect(firstRows).toHaveLength(1);
      for (const row of firstRows) expect(row.addEventListener).toHaveBeenCalledWith('dragstart', expect.any(Function));

      // Any later refresh - selecting a node, adding one, renaming one - goes through here.
      editor._renderInspector();
      const laterRows = editor.element.tracks.rows;
      expect(laterRows).toHaveLength(1);
      expect(laterRows[0]).not.toBe(firstRows[0]); // genuinely new elements, not the same ones
      for (const row of laterRows) expect(row.addEventListener).toHaveBeenCalledWith('dragstart', expect.any(Function));
    });

    it('the rebind runs once per Tracks rebuild - a stacked drop binding would create one node per accumulated bind', () => {
      const editor = editorWithSound();
      foundry.applications.ux.DragDrop.resetBindCallCount();

      editor._renderTracks();

      expect(foundry.applications.ux.DragDrop.bindCallCount).toBe(CustomPlaylistEditor.DEFAULT_OPTIONS.dragDrop.length);
    });

    it('_onDragStartInternal writes the exact payload shape Foundry\'s own sidebar drag produces', () => {
      const editor = editorWithSound();
      const setData = vi.fn();
      const row = { dataset: { dragType: 'PlaylistSound', uuid: 'Playlist.pl1.PlaylistSound.s1' } };
      const event = { target: { closest: (sel) => (sel === '[data-vg-drag]' ? row : null) }, dataTransfer: { setData } };

      editor._onDragStartInternal(event);

      expect(setData).toHaveBeenCalledWith('text/plain', JSON.stringify({ type: 'PlaylistSound', uuid: 'Playlist.pl1.PlaylistSound.s1' }));
    });

    it('_onDragOverExternal prevents default and marks the canvas drop-hover when the drag carries text/plain', () => {
      const editor = editorWithSound();
      const preventDefault = vi.fn();
      const classList = { add: vi.fn() };
      editor._onDragOverExternal({ preventDefault, dataTransfer: { types: { includes: () => true } }, currentTarget: { classList } });

      expect(preventDefault).toHaveBeenCalled();
      expect(classList.add).toHaveBeenCalledWith('drop-hover');
    });

    it('_onDragLeaveCanvas clears drop-hover only once the pointer has actually left the canvas box', () => {
      const editor = editorWithSound();
      const classList = { remove: vi.fn() };
      const box = { classList, contains: () => false };
      editor._onDragLeaveCanvas({ target: { closest: (sel) => (sel === '.game-orchestra-drawflow-canvas' ? box : null) }, relatedTarget: null });
      expect(classList.remove).toHaveBeenCalledWith('drop-hover');
    });

    it("_onDragLeaveCanvas leaves drop-hover alone when the pointer only moved between the canvas's own children", () => {
      const editor = editorWithSound();
      const classList = { remove: vi.fn() };
      const relatedTarget = {};
      const box = { classList, contains: (el) => el === relatedTarget };
      editor._onDragLeaveCanvas({ target: { closest: (sel) => (sel === '.game-orchestra-drawflow-canvas' ? box : null) }, relatedTarget });
      expect(classList.remove).not.toHaveBeenCalled();
    });

    /** A synthetic drop event, synchronous parts (currentTarget/point) captured the way the real handler does. */
    function dropEvent(payload) {
      return {
        preventDefault: vi.fn(),
        currentTarget: { classList: { remove: vi.fn() } },
        clientX: 150,
        clientY: 90,
        dataTransfer: { getData: () => JSON.stringify(payload) }
      };
    }

    it('a sound dropped from the playlist being edited creates a Track node with that sound preset', async () => {
      const editor = editorWithSound();
      global.fromUuid = vi.fn().mockResolvedValue({ id: 's1', parent: { id: 'pl1' } });

      await editor._onDropExternal(dropEvent({ type: 'PlaylistSound', uuid: 'Playlist.pl1.PlaylistSound.s1' }));

      const trackNode = editor.graph.nodes.find((n) => n.type === 'track');
      expect(trackNode?.soundId).toBe('s1');
    });

    it('a sound dropped from a DIFFERENT playlist is rejected with a warning, not silently turned into a Playlist node', async () => {
      const editor = editorWithSound();
      global.fromUuid = vi.fn().mockResolvedValue({ id: 'other-sound', parent: { id: 'pl-other' } });
      const warn = vi.spyOn(ui.notifications, 'warn');

      await editor._onDropExternal(dropEvent({ type: 'PlaylistSound', uuid: 'Playlist.pl-other.PlaylistSound.other-sound' }));

      expect(editor.graph.nodes.some((n) => n.type === 'track' && n.soundId)).toBe(false);
      expect(editor.graph.nodes.some((n) => n.type === 'playlist')).toBe(false);
      expect(warn).toHaveBeenCalledWith('GameOrchestra.CustomEditor.Drop.ForeignSound');
    });

    it('a different playlist dropped in creates a Playlist node with a direct reference to it', async () => {
      const editor = editorWithSound();
      global.fromUuid = vi.fn().mockResolvedValue({ id: 'pl-other' });

      await editor._onDropExternal(dropEvent({ type: 'Playlist', uuid: 'Playlist.pl-other' }));

      const playlistNode = editor.graph.nodes.find((n) => n.type === 'playlist');
      expect(playlistNode?.playlistRef).toMatchObject({ source: 'direct', playlistId: 'pl-other' });
    });

    it('the playlist being edited dropped onto itself is rejected', async () => {
      const editor = editorWithSound();
      global.fromUuid = vi.fn().mockResolvedValue({ id: 'pl1' });
      const warn = vi.spyOn(ui.notifications, 'warn');

      await editor._onDropExternal(dropEvent({ type: 'Playlist', uuid: 'Playlist.pl1' }));

      expect(editor.graph.nodes.some((n) => n.type === 'playlist')).toBe(false);
      expect(warn).toHaveBeenCalledWith('GameOrchestra.CustomEditor.Drop.SelfPlaylist');
    });

    it('a non-Foundry drag (malformed/absent dataTransfer payload) is a silent no-op, not an error toast', async () => {
      const editor = editorWithSound();
      const errorSpy = vi.spyOn(ui.notifications, 'error');
      const warnSpy = vi.spyOn(ui.notifications, 'warn');

      await editor._onDropExternal({
        preventDefault: vi.fn(),
        currentTarget: { classList: { remove: vi.fn() } },
        clientX: 0,
        clientY: 0,
        dataTransfer: { getData: () => 'not json' }
      });

      expect(errorSpy).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
      expect(editor.graph.nodes.length).toBe(1); // unchanged (just the skeleton's Start node)
    });

    it('does nothing if the window closed while the fromUuid() lookup was pending', async () => {
      const editor = editorWithSound();
      global.fromUuid = vi.fn().mockImplementation(async () => {
        editor._drawflow = null; // simulates _onClose() having run mid-await
        return { id: 's1', parent: { id: 'pl1' } };
      });

      await expect(editor._onDropExternal(dropEvent({ type: 'PlaylistSound', uuid: 'Playlist.pl1.PlaylistSound.s1' }))).resolves.not.toThrow();
    });

    it('places the new node at the drop point, mapped through the canvas pan/zoom', async () => {
      const editor = editorWithSound();
      editor._drawflow.canvas_x = -50;
      editor._drawflow.canvas_y = -20;
      editor._drawflow.zoom = 2;
      editor._drawflow.precanvas = { getBoundingClientRect: () => ({ left: 10, top: 5 }) };
      global.fromUuid = vi.fn().mockResolvedValue({ id: 's1', parent: { id: 'pl1' } });

      await editor._onDropExternal(dropEvent({ type: 'PlaylistSound', uuid: 'Playlist.pl1.PlaylistSound.s1' }));

      const trackNode = editor.graph.nodes.find((n) => n.type === 'track');
      const nodeId = editor._drawflow._nodes && Object.keys(editor._drawflow._nodes).find((id) => editor._drawflow._nodes[id].data?.soundId === 's1');
      // (clientX - rect.left) / zoom - 70, (clientY - rect.top) / zoom - 40, per _pointFromEvent().
      expect(editor._drawflow._nodes[nodeId].pos_x).toBeCloseTo((150 - 10) / 2 - 70);
      expect(editor._drawflow._nodes[nodeId].pos_y).toBeCloseTo((90 - 5) / 2 - 40);
      expect(trackNode).toBeTruthy();
    });
  });

  // The canvas "+" affordance (_refreshExitAdder): adds an exit to a
  // Fork/Random/Condition without going through the Properties pane.
  describe('exit adder button on the canvas', () => {
    function mountedEditor() {
      global.Drawflow = createFakeDrawflowClass();
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', [createMockSound('s1', 'Track 1')]));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      return editor;
    }

    const adderOf = (editor, nodeId) => editor._drawflow.container.querySelector(`#node-${nodeId}`).querySelector('.game-orchestra-node-add-exit');

    afterEach(() => {
      delete global.Drawflow;
    });

    it.each([['fork'], ['random'], ['condition']])('a %s node carries one', (type) => {
      const editor = mountedEditor();
      const nodeId = editor._addNodeOfType(type);

      expect(adderOf(editor, nodeId)).toBeTruthy();
    });

    it.each([['track'], ['delay'], ['playlist'], ['end']])('a %s node carries none - its exit count is fixed', (type) => {
      const editor = mountedEditor();
      const nodeId = editor._addNodeOfType(type);

      expect(adderOf(editor, nodeId)).toBeNull();
    });

    it('dispatches the same addExit action the inspector button does, naming its own node', () => {
      const editor = mountedEditor();
      const nodeId = editor._addNodeOfType('random');

      const button = adderOf(editor, nodeId);
      expect(button.dataset.action).toBe('addExit');
      expect(button.dataset.nodeId).toBe(nodeId);
      expect(button.type).toBe('button');
    });

    // Drawflow's mousedown switches on ele_selected.classList[0]. The button
    // only escapes selecting the node (and starting a drag) because that switch
    // matches no case - which requires OUR class to be the first one.
    it('carries the add-exit class FIRST, so Drawflow classList[0] matches none of its cases', () => {
      const editor = mountedEditor();
      const nodeId = editor._addNodeOfType('fork');

      // className, not classList[0]: a real browser derives the latter from the
      // former, and className is what the editor actually writes.
      const first = adderOf(editor, nodeId).className.trim().split(/\s+/)[0];
      expect(first).toBe('game-orchestra-node-add-exit');
      // The cases Drawflow's mousedown switch does match - any of these first
      // and a press would select the node and start a drag.
      expect(['drawflow-node', 'output', 'main-path', 'parent-drawflow', 'drawflow']).not.toContain(first);
    });

    it('is labelled for screen readers and on hover, and says a Condition branch still needs a condition', () => {
      const editor = mountedEditor();
      const fork = editor._addNodeOfType('fork');
      const condition = editor._addNodeOfType('condition');

      expect(adderOf(editor, fork).title).toBe('GameOrchestra.CustomEditor.Node.AddExit');
      expect(adderOf(editor, fork).getAttribute('aria-label')).toBe('GameOrchestra.CustomEditor.Node.AddExit');
      expect(adderOf(editor, condition).title).toBe('GameOrchestra.CustomEditor.Node.AddBranch');
    });

    it('is not duplicated by repeated refreshes', () => {
      const editor = mountedEditor();
      const nodeId = editor._addNodeOfType('condition');
      const nodeEl = editor._drawflow.container.querySelector(`#node-${nodeId}`);

      editor._refreshNodeDisplay(nodeId);
      editor._refreshNodeDisplay(nodeId);

      expect(nodeEl.children.filter((c) => String(c.className).includes('game-orchestra-node-add-exit'))).toHaveLength(1);
    });

    it('adds a port and leaves the selection (and so the Properties pane) alone', () => {
      const editor = mountedEditor();
      const nodeId = editor._addNodeOfType('fork');
      editor.selectedNodeId = null;
      const before = Object.keys(editor._drawflow._nodes[nodeId].outputs).length;

      const button = adderOf(editor, nodeId);
      CustomPlaylistEditor.handleAddExit.call(editor, { preventDefault: vi.fn() }, button);

      expect(Object.keys(editor._drawflow._nodes[nodeId].outputs)).toHaveLength(before + 1);
      expect(editor.selectedNodeId).toBeNull();
    });

    it('a press on it never starts a group drag, even with a marquee selection live', () => {
      const editor = mountedEditor();
      const nodeId = editor._addNodeOfType('random');
      const nodeEl = editor._drawflow.container.querySelector(`#node-${nodeId}`);
      const button = adderOf(editor, nodeId);
      editor._multiSelectedNodeIds = new Set([nodeId]);
      const target = {
        classList: { contains: () => false },
        closest: (sel) => (sel === '.game-orchestra-node-add-exit' ? button : sel === '.drawflow-node' ? nodeEl : null)
      };

      expect(editor._groupDragTarget(target)).toBeNull();
      // Sanity: the same node without the button under the pointer DOES drag.
      expect(editor._groupDragTarget({ classList: { contains: () => false }, closest: (sel) => (sel === '.drawflow-node' ? nodeEl : null) })).toBe(nodeEl);
    });
  });

  // A Track node's sound is fixed at creation and shown read-only in the
  // inspector, so a palette-created Track could never be given one - it would
  // sit on the canvas failing TrackNoSound with no way to fix it.
  describe('the palette offers no Track node', () => {
    it('lists every node type except track', () => {
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', []));

      const types = editor._prepareContext({}).palette.map((entry) => entry.type);

      expect(types).not.toContain('track');
      expect(types).toEqual(['start', 'playlist', 'fork', 'delay', 'random', 'condition', 'end']);
    });
  });

  // Undo/redo (graph-history.mjs). The history is per-window and in-memory: it
  // is seeded at mount and dies with the instance.
  describe('undo/redo', () => {
    function mountedEditor(soundCount = 2) {
      global.Drawflow = createFakeDrawflowClass();
      const sounds = Array.from({ length: soundCount }, (_, i) => createMockSound(`s${i + 1}`, `Track ${i + 1}`));
      const editor = new CustomPlaylistEditor(createMockPlaylist('pl1', 'Playlist', sounds));
      editor.element = createFakeElement();
      editor._mountDrawflow();
      return editor;
    }

    /**
     * _recordHistory() defers its capture to a microtask so that one gesture
     * producing several mutations becomes ONE step - so a test has to let the
     * queue drain before asserting. Two turns: one for the queued capture,
     * one for anything it queues in turn.
     */
    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
    };

    const nodeIds = (editor) => editor.graph.nodes.map((n) => n.id);
    const keyEvent = (key, extra = {}) => ({
      key,
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
      ...extra
    });

    afterEach(() => {
      delete global.Drawflow;
    });

    it('seeds the history at mount, with nothing yet to undo', () => {
      const editor = mountedEditor();

      expect(editor._history.canUndo).toBe(false);
      expect(editor._history.canRedo).toBe(false);
      expect(editor.element.undoButton.disabled).toBe(true);
      expect(editor.element.redoButton.disabled).toBe(true);
    });

    it('undoes an added node, and redoes it back', async () => {
      const editor = mountedEditor();
      const before = nodeIds(editor);
      const nodeId = editor._addNodeOfType('delay');
      await settle();

      expect(nodeIds(editor)).toContain(nodeId);
      expect(editor.element.undoButton.disabled).toBe(false);

      editor._undo();
      expect(nodeIds(editor)).toEqual(before);
      expect(editor.element.redoButton.disabled).toBe(false);

      editor._redo();
      expect(nodeIds(editor)).toContain(nodeId);
      expect(editor.element.redoButton.disabled).toBe(true);
    });

    it('undoes an inspector field edit', async () => {
      const editor = mountedEditor();
      const nodeId = editor._addNodeOfType('delay');
      await settle();

      CustomPlaylistEditor.handleUpdateNodeLabel.call(editor, {}, { dataset: { nodeId }, value: 'Renamed' });
      await settle();
      expect(editor.graph.nodes.find((n) => n.id === nodeId).label).toBe('Renamed');

      editor._undo();
      expect(editor.graph.nodes.find((n) => n.id === nodeId).label).not.toBe('Renamed');
    });

    it('records ONE step for a gesture that mutates several nodes', async () => {
      const editor = mountedEditor();
      const a = editor._addNodeOfType('delay');
      await settle();
      const b = editor._addNodeOfType('fork');
      await settle();

      // A marquee delete removes each node separately, firing Drawflow's own
      // 'nodeRemoved' per node - without coalescing this would need two
      // presses of Ctrl+Z to come back.
      editor._multiSelectedNodeIds = new Set([a, b]);
      editor._deleteMultiSelection();
      await settle();
      expect(nodeIds(editor)).not.toContain(a);
      expect(nodeIds(editor)).not.toContain(b);

      editor._undo();
      expect(nodeIds(editor)).toContain(a);
      expect(nodeIds(editor)).toContain(b);
    });

    it("carries a legacy graph crossfade through undo/redo, so stepping back never quietly erases a value this window can no longer restore", async () => {
      global.Drawflow = createFakeDrawflowClass();
      const playlist = createMockPlaylist('pl1', 'Playlist', []);
      // As it arrives from a graph saved before the field moved to the mixer.
      playlist.setFlag('game-orchestra', 'customPlayback', { version: 1, nodes: [{ id: '1', type: 'start' }], edges: [], crossfadeMs: 400 });
      const editor = new CustomPlaylistEditor(playlist);
      editor.element = createFakeElement();
      editor._mountDrawflow();
      editor._addNodeOfType('delay');
      await settle();
      expect(editor.graph.crossfadeMs).toBe(400);

      editor._undo();

      // The snapshot the undo restores was taken while the value was already 400, so it comes
      // back with it. Nothing in this window edits it any more - the mixer does - but dropping
      // it on an undo would be a silent data loss with no way to type it back in here.
      expect(editor.graph.crossfadeMs).toBe(400);
    });

    it('records a level change as its own undo step - it is made in the same pane as every graph edit', async () => {
      const editor = mountedEditor();
      editor._renderTracks(); // creates the pane's controller, as mounting the window does
      const sound = editor.playlist.sounds.get('s1');
      sound.volume = 0.8;
      editor._mixer._setSoundVolume(sound, 0.2);
      // The commit is debounced on the same window as the write - one drag is one step, not one
      // per pixel - so the step only exists once it fires.
      await new Promise((resolve) => setTimeout(resolve, 150));
      await settle();

      expect(editor._history.canUndo).toBe(true);
    });

    it('restores the levels a snapshot was taken with, by writing them back to the documents', async () => {
      const editor = mountedEditor();
      editor._renderTracks();
      const sound = editor.playlist.sounds.get('s1');
      sound.volume = 0.8;
      // Seed a snapshot holding the loud value, then change it.
      editor._recordHistory();
      await settle();
      editor._mixer._setSoundVolume(sound, 0.2);
      await new Promise((resolve) => setTimeout(resolve, 150));
      await settle();

      editor._undo();
      await settle();

      // Levels are already persisted when captured, so putting them back is a document write -
      // the one part of an undo in this window that touches the world.
      expect(editor.playlist.updateEmbeddedDocuments).toHaveBeenCalledWith('PlaylistSound', expect.arrayContaining([{ _id: 's1', volume: 0.8, fade: null }]));
    });

    it('writes nothing when undoing a pure graph edit - unchanged levels cost no round-trips', async () => {
      const editor = mountedEditor();
      editor._addNodeOfType('delay');
      await settle();
      editor.playlist.updateEmbeddedDocuments.mockClear();

      editor._undo();
      await settle();

      expect(editor.playlist.updateEmbeddedDocuments).not.toHaveBeenCalled();
    });

    it('does not create a step for a resync that changed nothing', async () => {
      const editor = mountedEditor();
      editor._syncFromDrawflow(editor._drawflow);
      await settle();

      expect(editor._history.canUndo).toBe(false);
    });

    it('does not record the restore itself as a new edit', async () => {
      const editor = mountedEditor();
      editor._addNodeOfType('delay');
      await settle();
      expect(editor._history.depth).toEqual({ past: 1, future: 0 });

      editor._undo();
      await settle();
      expect(editor._history.depth).toEqual({ past: 0, future: 1 });

      editor._redo();
      await settle();
      expect(editor._history.depth).toEqual({ past: 1, future: 0 });
    });

    it('discards the redo branch when a new edit follows an undo', async () => {
      const editor = mountedEditor();
      editor._addNodeOfType('delay');
      await settle();
      editor._undo();
      expect(editor._history.canRedo).toBe(true);

      editor._addNodeOfType('fork');
      await settle();

      expect(editor._history.canRedo).toBe(false);
      expect(editor.element.redoButton.disabled).toBe(true);
    });

    it('restores the selection a step was taken with, skipping nodes the restored graph lost', async () => {
      const editor = mountedEditor();
      const first = editor._addNodeOfType('delay');
      await settle();
      editor._selectSingleNode(first);
      const second = editor._addNodeOfType('fork');
      await settle();

      editor._undo();
      expect(editor.selectedNodeId).toBe(first);

      // The step that ADDED `first` was taken with nothing selected, and
      // `second` is gone from that state entirely - neither may be reselected.
      editor._undo();
      expect(editor.selectedNodeId).toBeNull();
      expect(nodeIds(editor)).not.toContain(second);
    });

    it('undoes an applied preset, which replaces the whole canvas', async () => {
      const editor = mountedEditor(2);
      const before = nodeIds(editor);

      await CustomPlaylistEditor.handleApplyPreset.call(editor, {}, { value: 'single-loop' });
      await settle();
      expect(nodeIds(editor).length).toBeGreaterThan(before.length);

      editor._undo();
      expect(nodeIds(editor)).toEqual(before);
    });

    it("repaints the live playback highlight, which the restore's import destroys", async () => {
      const editor = mountedEditor();
      const playing = editor._addNodeOfType('delay');
      await settle();
      editor._addNodeOfType('fork');
      await settle();
      editor._onGraphActivity({ playlistId: 'pl1', activeNodeIds: [playing], traversedEdgeIds: [] });
      expect(editor._activityHighlight).not.toBeNull();
      const repaint = vi.spyOn(editor, '_applyActivityHighlight');

      editor._undo();

      // Without this the canvas goes dark until the engine's next broadcast -
      // mid-track, a whole track away.
      expect(repaint).toHaveBeenCalled();
      expect(editor._drawflow.container.querySelector(`#node-${playing}`).classList.contains('game-orchestra-node-active')).toBe(true);
    });

    it('is a no-op at either end of the history', () => {
      const editor = mountedEditor();
      const before = nodeIds(editor);

      expect(() => editor._undo()).not.toThrow();
      expect(() => editor._redo()).not.toThrow();
      expect(nodeIds(editor)).toEqual(before);
    });

    describe('keyboard', () => {
      it('undoes on Ctrl+Z and redoes on both Ctrl+Shift+Z and Ctrl+Y', async () => {
        const editor = mountedEditor();
        const nodeId = editor._addNodeOfType('delay');
        await settle();

        editor._onKeyDown(keyEvent('z'));
        expect(nodeIds(editor)).not.toContain(nodeId);

        editor._onKeyDown(keyEvent('Z', { shiftKey: true }));
        expect(nodeIds(editor)).toContain(nodeId);

        editor._onKeyDown(keyEvent('z'));
        editor._onKeyDown(keyEvent('y'));
        expect(nodeIds(editor)).toContain(nodeId);
      });

      it('stops the event reaching Foundry, whose own Ctrl+Z undoes a scene edit', async () => {
        const editor = mountedEditor();
        editor._addNodeOfType('delay');
        await settle();
        const event = keyEvent('z');

        editor._onKeyDown(event);

        // preventDefault alone is not enough: Foundry's KeyboardManager listens
        // on window and ignores defaultPrevented entirely.
        expect(event.stopPropagation).toHaveBeenCalled();
        expect(event.preventDefault).toHaveBeenCalled();
      });

      it('leaves Ctrl+Z alone while a text field has focus, so native text undo still works', async () => {
        const editor = mountedEditor();
        const nodeId = editor._addNodeOfType('delay');
        await settle();
        global.document.activeElement = { tagName: 'INPUT' };

        editor._onKeyDown(keyEvent('z'));

        expect(nodeIds(editor)).toContain(nodeId);
        global.document.activeElement = null;
      });
    });
  });
});
