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
  const LINK_DISTANCE = 96;
  const ALPHA_DECAY = 0.028;
  const ALPHA_MIN = 0.0015;
  const POSITION_KEY = "pa-memory-graph-positions";

  function recencyColor(value) {
    const mix = clamp(value);
    const channels = SLATE.map((channel, index) =>
      Math.round(channel + ((AMBER[index] ?? channel) - channel) * mix),
    );
    return `rgb(${channels[0]}, ${channels[1]}, ${channels[2]})`;
  }

  function createSimulation(snapshot, previous) {
    const enabled = {
      semantic: true,
      temporal: true,
      entity: true,
      derived: true,
    };
    const nodes = [];
    const edges = [];
    let alpha = 1;
    let settledNotified = false;
    let paused = false;
    let panX = 0;
    let panY = 0;
    let zoom = 1;
    const remembered = Object.assign(
      readStoredPositions(),
      previous?.positions ?? {},
    );

    function visibleEdges() {
      return edges.filter((edge) => enabled[edge.type] !== false);
    }

    function radiusOf(node) {
      return 12 + Math.min(node.sourceFactCount, 6) * 2;
    }

    function place(node, index, total) {
      const stored = remembered[node.id];
      if (stored && Number.isFinite(stored.x) && Number.isFinite(stored.y)) {
        node.x = stored.x;
        node.y = stored.y;
        node.vx = 0;
        node.vy = 0;
        return;
      }
      const turn = index * 0.62;
      const ring = 36 + Math.sqrt(Math.max(total, 1)) * 28 + index * 4;
      node.x = Math.cos(turn) * ring;
      node.y = Math.sin(turn) * ring;
      node.vx = 0;
      node.vy = 0;
    }

    function remember() {
      for (const node of nodes) {
        remembered[node.id] = { x: node.x, y: node.y };
      }
      writeStoredPositions(remembered);
    }

    function sync(next) {
      const source = Array.isArray(next?.nodes) ? next.nodes : [];
      const rawEdges = Array.isArray(next?.edges) ? next.edges : [];
      const prior = new Map(nodes.map((node) => [node.id, node]));
      const fresh = [];
      let added = 0;
      source.forEach((item, index) => {
        const id = String(item.id);
        const existing = prior.get(id);
        if (existing) {
          existing.label = String(item.label ?? existing.label);
          existing.kind = String(item.kind ?? existing.kind);
          existing.recency = Number(item.recency) || 0;
          existing.derived = item.derived === true;
          existing.sourceFactCount = Number(item.sourceFactCount) || 1;
          fresh.push(existing);
          return;
        }
        const node = {
          id,
          label: String(item.label ?? ""),
          kind: String(item.kind ?? "world"),
          recency: Number(item.recency) || 0,
          derived: item.derived === true,
          sourceFactCount: Number(item.sourceFactCount) || 1,
          x: 0,
          y: 0,
          vx: 0,
          vy: 0,
        };
        place(node, prior.size + added + index, source.length);
        fresh.push(node);
        added += 1;
      });
      nodes.splice(0, nodes.length, ...fresh);
      edges.splice(
        0,
        edges.length,
        ...rawEdges.map((edge) => ({
          source: String(edge.source),
          target: String(edge.target),
          type: String(edge.type),
          weight: Number(edge.weight) || 1,
        })),
      );
      if (added > 0) {
        reheat(0.45);
      }
      remember();
    }

    function reheat(amount) {
      const next = Number.isFinite(amount) ? amount : 0.22;
      alpha = Math.max(alpha, next);
    }

    function step() {
      if (paused || alpha <= 0 || nodes.length === 0) {
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
          if (distance < 0.05) {
            const angle = left * 1.7 + right;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            distance = 1;
          }
          const push = Math.min(18, (420 * alpha) / (distance * distance));
          const ux = dx / distance;
          const uy = dy / distance;
          a.vx += ux * push;
          a.vy += uy * push;
          b.vx -= ux * push;
          b.vy -= uy * push;
        }
      }
      for (const edge of visibleEdges()) {
        const a = byId.get(edge.source);
        const b = byId.get(edge.target);
        if (!a || !b) {
          continue;
        }
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.05) {
          dx = LINK_DISTANCE;
          dy = 0;
          distance = LINK_DISTANCE;
        }
        const pull = ((distance - LINK_DISTANCE) / distance) * 0.12 * alpha;
        a.vx += dx * pull;
        a.vy += dy * pull;
        b.vx -= dx * pull;
        b.vy -= dy * pull;
      }
      let centerX = 0;
      let centerY = 0;
      for (const node of nodes) {
        centerX += node.x;
        centerY += node.y;
      }
      centerX /= nodes.length;
      centerY /= nodes.length;
      for (const node of nodes) {
        node.vx -= centerX * 0.04 * alpha;
        node.vy -= centerY * 0.04 * alpha;
      }
      for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
          const a = nodes[left];
          const b = nodes[right];
          const minDist = radiusOf(a) + radiusOf(b) + 8;
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distance = Math.hypot(dx, dy);
          if (distance < 0.05) {
            dx = 1;
            dy = 0;
            distance = 1;
          }
          if (distance >= minDist) {
            continue;
          }
          const overlap = (minDist - distance) / 2;
          const ux = dx / distance;
          const uy = dy / distance;
          a.x -= ux * overlap;
          a.y -= uy * overlap;
          b.x += ux * overlap;
          b.y += uy * overlap;
          a.vx *= 0.4;
          a.vy *= 0.4;
          b.vx *= 0.4;
          b.vy *= 0.4;
        }
      }
      for (const node of nodes) {
        node.vx *= 0.55;
        node.vy *= 0.55;
        const speed = Math.hypot(node.vx, node.vy);
        if (speed > 14) {
          node.vx = (node.vx / speed) * 14;
          node.vy = (node.vy / speed) * 14;
        }
        node.x += node.vx;
        node.y += node.vy;
      }
      alpha *= 1 - ALPHA_DECAY;
      if (alpha < ALPHA_MIN) {
        alpha = 0;
        for (const node of nodes) {
          node.vx = 0;
          node.vy = 0;
        }
      }
      remember();
      return nodes;
    }

    function kinetic() {
      let energy = 0;
      for (const node of nodes) {
        energy += node.vx * node.vx + node.vy * node.vy;
      }
      return energy;
    }

    function justSettled() {
      if (alpha !== 0 || settledNotified) {
        return false;
      }
      settledNotified = true;
      return true;
    }

    function fit(width, height) {
      if (nodes.length === 0) {
        return;
      }
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of nodes) {
        const radius = radiusOf(node);
        minX = Math.min(minX, node.x - radius);
        minY = Math.min(minY, node.y - radius);
        maxX = Math.max(maxX, node.x + radius);
        maxY = Math.max(maxY, node.y + radius);
      }
      const boundsWidth = Math.max(maxX - minX, 1);
      const boundsHeight = Math.max(maxY - minY, 1);
      const pad = 36;
      zoom = clampZoom(
        Math.min(
          (width - pad * 2) / boundsWidth,
          (height - pad * 2) / boundsHeight,
        ),
      );
      const midX = (minX + maxX) / 2;
      const midY = (minY + maxY) / 2;
      panX = -midX * zoom;
      panY = -midY * zoom;
    }

    function setPaused(value) {
      paused = value === true;
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

    function moveNode(id, worldX, worldY, options) {
      const node = nodes.find((item) => item.id === id);
      if (!node) {
        return;
      }
      node.x = worldX;
      node.y = worldY;
      node.vx = 0;
      node.vy = 0;
      if (options?.reheat) {
        reheat(0.2);
      }
      remember();
    }

    function screenToWorld(screenX, screenY) {
      return {
        x: (screenX - panX) / zoom,
        y: (screenY - panY) / zoom,
      };
    }

    sync(snapshot);
    if (
      Object.keys(previous?.positions ?? {}).length === 0 &&
      nodes.length > 0
    ) {
      const hasStored = nodes.some((node) => remembered[node.id]);
      if (!hasStored) {
        alpha = 1;
      }
    }

    return {
      nodes,
      edges,
      step,
      sync,
      reheat,
      kinetic,
      justSettled,
      fit,
      alpha() {
        return alpha;
      },
      isSettled() {
        return alpha <= 0;
      },
      setPaused,
      isPaused() {
        return paused;
      },
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

  function readStoredPositions() {
    try {
      if (typeof sessionStorage === "undefined") {
        return {};
      }
      const raw = sessionStorage.getItem(POSITION_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  function writeStoredPositions(positions) {
    try {
      if (typeof sessionStorage === "undefined") {
        return;
      }
      sessionStorage.setItem(POSITION_KEY, JSON.stringify(positions));
    } catch {
      // A private window can refuse storage. The in-memory layout still holds.
    }
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
    return Math.min(4, Math.max(0.25, value));
  }

  root.PersonalAgentsGraph = {
    EDGE_COLORS,
    LEGEND,
    recencyColor,
    createSimulation,
  };
})(globalThis);
