((root) => {
  const SLATE = [100, 116, 139];
  const AMBER = [217, 119, 6];
  const EDGE_COLORS = {
    semantic: "#0f766e",
    temporal: "#4f46e5",
    entity: "#b45309",
    derived: "#6d28d9",
  };
  const LEGEND = [
    { id: "recency", label: "Recency, older to newer" },
    { id: "semantic", label: "Semantic" },
    { id: "temporal", label: "Temporal" },
    { id: "entity", label: "Entity" },
    { id: "derived", label: "Derived" },
  ];

  function recencyColor(value) {
    const mix = clamp(value);
    const channels = SLATE.map((channel, index) =>
      Math.round(channel + ((AMBER[index] ?? channel) - channel) * mix),
    );
    return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
  }

  function createSimulation(snapshot) {
    const source = Array.isArray(snapshot?.nodes) ? snapshot.nodes : [];
    const rawEdges = Array.isArray(snapshot?.edges) ? snapshot.edges : [];
    const count = Math.max(source.length, 1);
    const nodes = source.map((node, index) => {
      const angle = (index / count) * Math.PI * 2;
      return {
        id: String(node.id),
        label: String(node.label ?? ""),
        kind: String(node.kind ?? "world"),
        recency: Number(node.recency) || 0,
        derived: node.derived === true,
        sourceFactCount: Number(node.sourceFactCount) || 1,
        x: Math.cos(angle) * 48,
        y: Math.sin(angle) * 48,
        vx: 0,
        vy: 0,
      };
    });
    const edges = rawEdges.map((edge) => ({
      source: String(edge.source),
      target: String(edge.target),
      type: String(edge.type),
      weight: Number(edge.weight) || 1,
    }));
    const enabled = {
      semantic: true,
      temporal: true,
      entity: true,
      derived: true,
    };
    let paused = false;
    let panX = 0;
    let panY = 0;
    let zoom = 1;

    function visibleEdges() {
      return edges.filter((edge) => enabled[edge.type] !== false);
    }

    function step() {
      if (paused) {
        return nodes;
      }
      const byId = new Map(nodes.map((node) => [node.id, node]));
      for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
          const a = nodes[left];
          const b = nodes[right];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.01) {
            dx = 0.01;
            dy = 0;
            distance = 0.01;
          }
          const push = 180 / (distance * distance);
          a.vx += (dx / distance) * push;
          a.vy += (dy / distance) * push;
          b.vx -= (dx / distance) * push;
          b.vy -= (dy / distance) * push;
        }
      }
      for (const edge of visibleEdges()) {
        const a = byId.get(edge.source);
        const b = byId.get(edge.target);
        if (!a || !b) {
          continue;
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        a.vx += dx * 0.02;
        a.vy += dy * 0.02;
        b.vx -= dx * 0.02;
        b.vy -= dy * 0.02;
      }
      for (const node of nodes) {
        node.vx = (node.vx - node.x * 0.02) * 0.8;
        node.vy = (node.vy - node.y * 0.02) * 0.8;
        node.x += node.vx;
        node.y += node.vy;
      }
      return nodes;
    }

    function setPaused(value) {
      paused = value === true;
    }

    function isPaused() {
      return paused;
    }

    function setEdgeEnabled(type, on) {
      if (Object.hasOwn(enabled, type)) {
        enabled[type] = on === true;
      }
    }

    function panBy(dx, dy) {
      panX += dx;
      panY += dy;
    }

    function zoomAt(factor, screenX, screenY) {
      const next = clampZoom(zoom * factor);
      const worldX = (screenX - panX) / zoom;
      const worldY = (screenY - panY) / zoom;
      zoom = next;
      panX = screenX - worldX * zoom;
      panY = screenY - worldY * zoom;
    }

    function toScreen(x, y) {
      return { x: x * zoom + panX, y: y * zoom + panY };
    }

    function radiusOf(node) {
      return 8 + Math.min(node.sourceFactCount, 8) * 2;
    }

    function hit(screenX, screenY) {
      const worldX = (screenX - panX) / zoom;
      const worldY = (screenY - panY) / zoom;
      let found = null;
      for (const node of nodes) {
        const radius = radiusOf(node);
        const dx = worldX - node.x;
        const dy = worldY - node.y;
        if (dx * dx + dy * dy <= radius * radius) {
          found = node;
        }
      }
      return found;
    }

    function moveNode(id, worldX, worldY) {
      const node = nodes.find((item) => item.id === id);
      if (!node) {
        return;
      }
      node.x = worldX;
      node.y = worldY;
      node.vx = 0;
      node.vy = 0;
    }

    function screenToWorld(screenX, screenY) {
      return {
        x: (screenX - panX) / zoom,
        y: (screenY - panY) / zoom,
      };
    }

    return {
      nodes,
      step,
      setPaused,
      isPaused,
      setEdgeEnabled,
      visibleEdges,
      panBy,
      zoomAt,
      toScreen,
      hit,
      moveNode,
      screenToWorld,
      radiusOf,
      view() {
        return { panX, panY, zoom };
      },
    };
  }

  function clamp(value) {
    if (!Number.isFinite(value)) {
      return 0;
    }
    return Math.min(1, Math.max(0, value));
  }

  function clampZoom(value) {
    if (!Number.isFinite(value)) {
      return 1;
    }
    return Math.min(4, Math.max(0.3, value));
  }

  root.PersonalAgentsGraph = {
    EDGE_COLORS,
    LEGEND,
    recencyColor,
    createSimulation,
  };
})(globalThis);
