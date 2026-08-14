"use client";

import {
  drag,
  easeCubicOut,
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  select,
  zoom,
  zoomIdentity,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
  type ZoomBehavior,
  type ZoomTransform,
} from "d3";
import { Focus, Maximize2, RotateCcw, ZoomIn, ZoomOut } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import type {
  GraphEdge,
  GraphEdgeKind,
  GraphNode,
  GraphNodeKind,
  KnowledgeGraph,
} from "@/lib/types";
import styles from "./knowledge-graph-canvas.module.css";

const MIN_SCALE = 0.22;
const MAX_SCALE = 4;
const DEFAULT_SIZE = { width: 900, height: 540 };

const KIND_META: Record<
  GraphNodeKind,
  { label: string; radius: number; x: number; y: number; force: number }
> = {
  note: { label: "Note", radius: 6.5, x: 0.34, y: 0.43, force: 0.045 },
  memory: { label: "Memory", radius: 8.5, x: 0.43, y: 0.58, force: 0.06 },
  skill: { label: "Skill", radius: 9.5, x: 0.64, y: 0.43, force: 0.065 },
  insight: { label: "Insight", radius: 11, x: 0.52, y: 0.49, force: 0.085 },
  task: { label: "Task", radius: 7.5, x: 0.63, y: 0.63, force: 0.052 },
};

type GraphSimulationNode = GraphNode &
  SimulationNodeDatum & {
    radius: number;
    degree: number;
    labelRank: number;
  };

type GraphSimulationLink = SimulationLinkDatum<GraphSimulationNode> & {
  id: string;
  sourceId: string;
  targetId: string;
  relation: string;
  kind: GraphEdgeKind;
  weight: number;
};

export type KnowledgeGraphCanvasHandle = {
  fit: () => void;
  focus: (nodeId: string) => void;
  reheat: () => void;
  reset: () => void;
};

export type KnowledgeGraphCanvasProps = {
  graph: KnowledgeGraph;
  selected: string | null;
  filters: ReadonlySet<GraphNodeKind>;
  onSelect: (nodeId: string) => void;
  onClearSelection?: () => void;
  onFocusNeighborhood?: (nodeId: string, neighborIds: string[]) => void;
  /** Change this value to deliberately restart and settle the current layout. */
  layoutRevision?: string | number;
  autoFitOnChange?: boolean;
  className?: string;
};

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function hashString(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function edgeKind(edge: GraphEdge): GraphEdgeKind {
  if (edge.kind === "semantic" || edge.kind === "explicit" || edge.kind === "co-occurrence") {
    return edge.kind;
  }
  const relation = (edge.relation || "semantic").toLowerCase();
  if (/explicit|backlink|reference|wiki|link|derived/.test(relation)) return "explicit";
  if (/co[-_ ]?occurrence|repeat|usage|used with|mention|tag/.test(relation)) return "co-occurrence";
  return "semantic";
}

function edgeDistance(link: GraphSimulationLink) {
  const base = link.kind === "explicit" ? 72 : link.kind === "co-occurrence" ? 96 : 118;
  return base + (1 - link.weight) * 56;
}

function edgeOpacity(link: GraphSimulationLink) {
  return 0.12 + link.weight * 0.42;
}

function elide(value: string, limit: number) {
  return value.length > limit ? `${value.slice(0, limit - 1)}…` : value;
}

function joinClassNames(...values: Array<string | null | undefined | false>) {
  return values.filter(Boolean).join(" ");
}

function neighborhoodFor(adjacency: Map<string, Set<string>>, id: string | null) {
  if (!id || !adjacency.has(id)) return new Set<string>();
  return new Set([id, ...(adjacency.get(id) ?? [])]);
}

function fitTransform(
  nodes: GraphSimulationNode[],
  width: number,
  height: number,
  maximumScale = 1.65,
): ZoomTransform {
  if (!nodes.length) return zoomIdentity;

  let left = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;

  nodes.forEach((node) => {
    const x = node.x ?? width / 2;
    const y = node.y ?? height / 2;
    const padding = node.radius + 28;
    left = Math.min(left, x - padding);
    right = Math.max(right, x + padding);
    top = Math.min(top, y - padding);
    bottom = Math.max(bottom, y + padding);
  });

  const graphWidth = Math.max(80, right - left);
  const graphHeight = Math.max(80, bottom - top);
  const scale = clamp(
    Math.min((width * 0.88) / graphWidth, (height * 0.86) / graphHeight),
    MIN_SCALE,
    maximumScale,
  );
  const centerX = (left + right) / 2;
  const centerY = (top + bottom) / 2;
  return zoomIdentity
    .translate(width / 2 - centerX * scale, height / 2 - centerY * scale)
    .scale(scale);
}

export const KnowledgeGraphCanvas = forwardRef<
  KnowledgeGraphCanvasHandle,
  KnowledgeGraphCanvasProps
>(function KnowledgeGraphCanvas(
  {
    graph,
    selected,
    filters,
    onSelect,
    onClearSelection,
    onFocusNeighborhood,
    layoutRevision = 0,
    autoFitOnChange = true,
    className,
  },
  forwardedRef,
) {
  const rootRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const viewportRef = useRef<SVGGElement>(null);
  const linkLayerRef = useRef<SVGGElement>(null);
  const nodeLayerRef = useRef<SVGGElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const tooltipTitleRef = useRef<HTMLSpanElement>(null);
  const tooltipMetaRef = useRef<HTMLSpanElement>(null);
  const simulationRef = useRef<Simulation<GraphSimulationNode, GraphSimulationLink> | null>(null);
  const zoomRef = useRef<ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<ZoomTransform>(zoomIdentity);
  const nodesRef = useRef<GraphSimulationNode[]>([]);
  const positionsRef = useRef(new Map<string, { x: number; y: number }>());
  const adjacencyRef = useRef(new Map<string, Set<string>>());
  const selectedRef = useRef<string | null>(selected);
  const hoveredRef = useRef<string | null>(null);
  const focusedRef = useRef<string | null>(null);
  const updateEmphasisRef = useRef<() => void>(() => undefined);
  const updateLabelsRef = useRef<(scale: number) => void>(() => undefined);
  const fitRef = useRef<() => void>(() => undefined);
  const resetRef = useRef<() => void>(() => undefined);
  const focusRef = useRef<(nodeId: string) => void>(() => undefined);
  const reheatRef = useRef<() => void>(() => undefined);
  const onSelectRef = useRef(onSelect);
  const onClearSelectionRef = useRef(onClearSelection);
  const onFocusNeighborhoodRef = useRef(onFocusNeighborhood);
  const reducedMotionRef = useRef(false);
  const [size, setSize] = useState(DEFAULT_SIZE);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);

  onSelectRef.current = onSelect;
  onClearSelectionRef.current = onClearSelection;
  onFocusNeighborhoodRef.current = onFocusNeighborhood;
  selectedRef.current = selected;

  const filterKey = Array.from(filters).sort().join("|");
  const visibleIds = new Set(
    graph.nodes.filter((node) => filters.has(node.kind)).map((node) => node.id),
  );
  const visibleNodeCount = visibleIds.size;
  const visibleLinkCount = graph.edges.filter(
    (edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target),
  ).length;

  const animateTransform = useCallback((transform: ZoomTransform) => {
    const svgElement = svgRef.current;
    const behavior = zoomRef.current;
    if (!svgElement || !behavior) return;
    const svg = select(svgElement);
    if (reducedMotionRef.current) {
      svg.call(behavior.transform, transform);
      return;
    }
    svg
      .transition("knowledge-graph-zoom")
      .duration(280)
      .ease(easeCubicOut)
      .call(behavior.transform, transform);
  }, []);

  const zoomBy = useCallback(
    (factor: number) => {
      const { width, height } = size;
      const current = transformRef.current;
      const nextScale = clamp(current.k * factor, MIN_SCALE, MAX_SCALE);
      const centerX = width / 2;
      const centerY = height / 2;
      const graphX = (centerX - current.x) / current.k;
      const graphY = (centerY - current.y) / current.k;
      animateTransform(
        zoomIdentity
          .translate(centerX - graphX * nextScale, centerY - graphY * nextScale)
          .scale(nextScale),
      );
    },
    [animateTransform, size],
  );

  useImperativeHandle(
    forwardedRef,
    () => ({
      fit: () => fitRef.current(),
      focus: (id) => focusRef.current(id),
      reheat: () => reheatRef.current(),
      reset: () => resetRef.current(),
    }),
    [],
  );

  useEffect(() => {
    reducedMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const bounds = root.getBoundingClientRect();
      const next = {
        width: Math.max(320, Math.round(bounds.width || DEFAULT_SIZE.width)),
        height: Math.max(420, Math.round(bounds.height || DEFAULT_SIZE.height)),
      };
      setSize((current) =>
        Math.abs(current.width - next.width) > 1 || Math.abs(current.height - next.height) > 1
          ? next
          : current,
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const svgElement = svgRef.current;
    const viewport = viewportRef.current;
    if (!svgElement || !viewport) return;

    const svg = select(svgElement);
    const behavior = zoom<SVGSVGElement, unknown>()
      .scaleExtent([MIN_SCALE, MAX_SCALE])
      .extent([
        [0, 0],
        [size.width, size.height],
      ])
      .translateExtent([
        [-size.width * 3, -size.height * 3],
        [size.width * 4, size.height * 4],
      ])
      .filter((event) => {
        if (event.type === "dblclick") return false;
        if (event.type === "wheel") return true;
        if ("button" in event && event.button !== 0) return false;
        const target = event.target as Element | null;
        return !target?.closest("[data-graph-node]");
      })
      .on("zoom.knowledge-graph", (event) => {
        transformRef.current = event.transform;
        select(viewport).attr("transform", event.transform.toString());
        updateLabelsRef.current(event.transform.k);
      });

    zoomRef.current = behavior;
    svg.call(behavior);
    svg.on("dblclick.zoom", null);
    svg.call(behavior.transform, transformRef.current);

    svg.on("click.knowledge-graph-background", (event) => {
      const target = event.target as Element | null;
      if (target?.closest("[data-graph-node]")) return;
      hoveredRef.current = null;
      focusedRef.current = null;
      setFocusedNodeId(null);
      if (tooltipRef.current) tooltipRef.current.dataset.visible = "false";
      onClearSelectionRef.current?.();
      updateEmphasisRef.current();
    });

    return () => {
      svg.interrupt("knowledge-graph-zoom");
      svg.on(".zoom", null);
      svg.on("click.knowledge-graph-background", null);
      if (zoomRef.current === behavior) zoomRef.current = null;
    };
  }, [size]);

  useEffect(() => {
    const rootElement = rootRef.current;
    const linkLayerElement = linkLayerRef.current;
    const nodeLayerElement = nodeLayerRef.current;
    if (!rootElement || !linkLayerElement || !nodeLayerElement) return;

    simulationRef.current?.stop();
    const { width, height } = size;
    const positionCache = positionsRef.current;
    const allowedKinds = new Set(filterKey.split("|").filter(Boolean) as GraphNodeKind[]);
    const uniqueNodes = Array.from(
      new Map(
        graph.nodes
          .filter((node) => allowedKinds.has(node.kind))
          .map((node) => [node.id, node] as const),
      ).values(),
    );
    const includedIds = new Set(uniqueNodes.map((node) => node.id));
    const degree = new Map<string, number>();
    const duplicateEdges = new Map<string, number>();

    const links: GraphSimulationLink[] = graph.edges
      .filter(
        (edge) =>
          edge.source !== edge.target &&
          includedIds.has(edge.source) &&
          includedIds.has(edge.target),
      )
      .map((edge) => {
        degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
        degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
        const relation = edge.relation || "semantic";
        const baseId = `${edge.source}\u0000${edge.target}\u0000${relation}`;
        const duplicate = duplicateEdges.get(baseId) ?? 0;
        duplicateEdges.set(baseId, duplicate + 1);
        return {
          id: `${baseId}\u0000${duplicate}`,
          source: edge.source,
          target: edge.target,
          sourceId: edge.source,
          targetId: edge.target,
          relation,
          kind: edgeKind(edge),
          weight: clamp(Number.isFinite(edge.weight) ? edge.weight : 0.5, 0.05, 1),
        };
      });

    const rankByWeight = [...uniqueNodes]
      .sort(
        (left, right) =>
          (degree.get(right.id) ?? 0) + right.weight * 2 -
          ((degree.get(left.id) ?? 0) + left.weight * 2),
      )
      .map((node, index) => [node.id, index] as const);
    const ranks = new Map(rankByWeight);

    const nodes: GraphSimulationNode[] = uniqueNodes.map((node) => {
      const previous = positionCache.get(node.id);
      const seed = hashString(`${node.id}:${layoutRevision}`);
      const angle = ((seed % 360) * Math.PI) / 180;
      const distance = 36 + ((seed >>> 8) % Math.max(64, Math.round(Math.min(width, height) * 0.3)));
      const kind = KIND_META[node.kind];
      const weight = clamp(Number.isFinite(node.weight) ? node.weight : 0.5, 0, 1);
      const x = previous?.x ?? width * kind.x + Math.cos(angle) * distance;
      const y = previous?.y ?? height * kind.y + Math.sin(angle) * distance * 0.72;
      return {
        ...node,
        weight,
        degree: degree.get(node.id) ?? 0,
        labelRank: ranks.get(node.id) ?? uniqueNodes.length,
        radius: kind.radius + Math.sqrt(weight) * 5 + Math.min(3, (degree.get(node.id) ?? 0) * 0.24),
        x,
        y,
      };
    });

    const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
    links.forEach((link) => {
      adjacency.get(link.sourceId)?.add(link.targetId);
      adjacency.get(link.targetId)?.add(link.sourceId);
    });
    adjacencyRef.current = adjacency;
    nodesRef.current = nodes;
    if (hoveredRef.current && !includedIds.has(hoveredRef.current)) hoveredRef.current = null;
    if (focusedRef.current && !includedIds.has(focusedRef.current)) {
      focusedRef.current = null;
      setFocusedNodeId(null);
    }

    const linkLayer = select(linkLayerElement);
    const linkJoin = linkLayer
      .selectAll<SVGLineElement, GraphSimulationLink>(`line.${styles.link}`)
      .data(links, (link) => link.id);

    linkJoin
      .exit()
      .interrupt()
      .transition()
      .duration(reducedMotionRef.current ? 0 : 150)
      .style("opacity", 0)
      .remove();

    const linkSelection = linkJoin
      .enter()
      .append("line")
      .attr("class", styles.link)
      .attr("data-edge-kind", (link) => link.kind)
      .attr("vector-effect", "non-scaling-stroke")
      .style("opacity", 0)
      .merge(linkJoin)
      .attr("data-edge-kind", (link) => link.kind)
      .attr("aria-hidden", "true");
    linkSelection.interrupt();

    const nodeLayer = select(nodeLayerElement);
    const nodeJoin = nodeLayer
      .selectAll<SVGGElement, GraphSimulationNode>(`g.${styles.node}`)
      .data(nodes, (node) => node.id);

    nodeJoin
      .exit()
      .interrupt()
      .transition()
      .duration(reducedMotionRef.current ? 0 : 170)
      .style("opacity", 0)
      .remove();

    const nodeEnter = nodeJoin
      .enter()
      .append("g")
      .attr("class", styles.node)
      .attr("data-graph-node", "true")
      .style("opacity", 0);

    nodeEnter.append("circle").attr("class", styles.halo).attr("aria-hidden", "true");
    nodeEnter.append("circle").attr("class", styles.core).attr("aria-hidden", "true");
    nodeEnter.append("circle").attr("class", styles.pupil).attr("aria-hidden", "true");
    nodeEnter.append("text").attr("class", styles.label).attr("text-anchor", "middle");
    nodeEnter.append("title");

    const nodeSelection = nodeEnter
      .merge(nodeJoin)
      .attr("data-kind", (node) => node.kind)
      .attr("data-node-id", (node) => node.id)
      .attr("role", "button")
      .attr("tabindex", 0)
      .attr(
        "aria-label",
        (node) =>
          `${node.title}, ${KIND_META[node.kind].label}, ${Math.round(node.weight * 100)}% graph strength, ${node.degree} connections`,
      );
    nodeSelection.interrupt();

    nodeSelection
      .select<SVGCircleElement>(`circle.${styles.halo}`)
      .attr("r", (node) => node.radius + 9);
    nodeSelection
      .select<SVGCircleElement>(`circle.${styles.core}`)
      .transition()
      .duration(reducedMotionRef.current ? 0 : 220)
      .ease(easeCubicOut)
      .attr("r", (node) => node.radius);
    nodeSelection
      .select<SVGCircleElement>(`circle.${styles.pupil}`)
      .attr("r", (node) => Math.max(2.2, node.radius * 0.27));
    nodeSelection
      .select<SVGTextElement>(`text.${styles.label}`)
      .attr("y", (node) => node.radius + 16)
      .text((node) => elide(node.title, 31));
    nodeSelection
      .select<SVGTitleElement>("title")
      .text(
        (node) =>
          `${node.title} — ${node.summary} (${node.degree} connections, ${Math.round(node.weight * 100)}% graph strength)`,
      );

    const simulation = forceSimulation<GraphSimulationNode>(nodes)
      .alpha(0.9)
      .alphaDecay(reducedMotionRef.current ? 0.12 : nodes.length > 260 ? 0.052 : 0.038)
      .velocityDecay(0.34)
      .force(
        "link",
        forceLink<GraphSimulationNode, GraphSimulationLink>(links)
          .id((node) => node.id)
          .distance(edgeDistance)
          .strength((link) => 0.13 + link.weight * 0.34),
      )
      .force(
        "charge",
        forceManyBody<GraphSimulationNode>()
          .strength((node) => -66 - node.radius * 4.1 - Math.min(node.degree, 16) * 2)
          .distanceMin(18)
          .distanceMax(Math.max(width, height) * 0.92)
          .theta(0.9),
      )
      .force(
        "collision",
        forceCollide<GraphSimulationNode>()
          .radius((node) => node.radius + (node.labelRank < 30 ? 13 : 6))
          .strength(0.9)
          .iterations(nodes.length > 260 ? 1 : 2),
      )
      .force(
        "kind-x",
        forceX<GraphSimulationNode>((node) => width * KIND_META[node.kind].x).strength(
          (node) => KIND_META[node.kind].force,
        ),
      )
      .force(
        "kind-y",
        forceY<GraphSimulationNode>((node) => height * KIND_META[node.kind].y).strength(
          (node) => KIND_META[node.kind].force * 0.82,
        ),
      )
      .force("center", forceCenter(width / 2, height / 2).strength(0.035));

    simulationRef.current = simulation;

    const ticked = () => {
      linkSelection
        .attr("x1", (link) => (link.source as GraphSimulationNode).x ?? width / 2)
        .attr("y1", (link) => (link.source as GraphSimulationNode).y ?? height / 2)
        .attr("x2", (link) => (link.target as GraphSimulationNode).x ?? width / 2)
        .attr("y2", (link) => (link.target as GraphSimulationNode).y ?? height / 2);
      nodeSelection.attr(
        "transform",
        (node) => `translate(${node.x ?? width / 2},${node.y ?? height / 2})`,
      );
    };

    simulation.stop();
    for (let index = 0; index < Math.min(22, 9 + Math.ceil(Math.sqrt(nodes.length))); index += 1) {
      simulation.tick();
    }
    ticked();
    simulation.on("tick.render", ticked).restart();

    const showTooltip = (event: PointerEvent, node: GraphSimulationNode) => {
      const tooltip = tooltipRef.current;
      if (!tooltip) return;
      if (tooltipTitleRef.current) tooltipTitleRef.current.textContent = node.title;
      if (tooltipMetaRef.current) {
        tooltipMetaRef.current.textContent = `${KIND_META[node.kind].label} · ${Math.round(node.weight * 100)}% graph strength · ${node.degree} links`;
      }
      const bounds = rootElement.getBoundingClientRect();
      const x = clamp(event.clientX - bounds.left + 14, 8, Math.max(8, bounds.width - 226));
      const y = clamp(event.clientY - bounds.top + 14, 8, Math.max(8, bounds.height - 76));
      tooltip.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      tooltip.dataset.visible = "true";
    };

    const hideTooltip = () => {
      if (tooltipRef.current) tooltipRef.current.dataset.visible = "false";
    };

    const updateLabels = (scale: number) => {
      const candidate = hoveredRef.current ?? focusedRef.current ?? selectedRef.current;
      const emphasisId = candidate && adjacency.has(candidate) ? candidate : null;
      const emphasized = neighborhoodFor(adjacency, emphasisId);
      const budget =
        scale < 0.52 ? 7 : scale < 0.78 ? 16 : scale < 1.15 ? 36 : scale < 1.8 ? 86 : 170;
      const screenFontSize = 10.5 + Math.min(1.5, Math.max(0, scale - 1) * 0.8);
      nodeSelection
        .select<SVGTextElement>(`text.${styles.label}`)
        .attr("font-size", screenFontSize / scale)
        .attr("y", (node) => node.radius + 12 / scale)
        .style("display", (node) =>
          node.labelRank < budget || emphasized.has(node.id) ? null : "none",
        )
        .style("opacity", (node) => {
          if (emphasisId) return emphasized.has(node.id) ? 1 : 0;
          return node.labelRank < budget ? clamp((scale - 0.28) * 1.45, 0.48, 1) : 0;
        });
    };

    const updateEmphasis = () => {
      const hoverId = hoveredRef.current;
      const focusId = focusedRef.current;
      const selectedId = selectedRef.current;
      const candidate = hoverId ?? focusId ?? selectedId;
      const emphasisId = candidate && adjacency.has(candidate) ? candidate : null;
      const emphasized = neighborhoodFor(adjacency, emphasisId);
      const stronglyDim = Boolean(hoverId || focusId);

      nodeSelection
        .classed(styles.selected, (node) => node.id === selectedId)
        .classed(styles.hovered, (node) => node.id === hoverId)
        .classed(styles.focused, (node) => node.id === focusId)
        .style("opacity", (node) => {
          if (!emphasisId) return 1;
          if (emphasized.has(node.id)) return 1;
          return stronglyDim ? 0.1 : 0.3;
        });

      linkSelection
        .classed(
          styles.emphasizedLink,
          (link) => link.sourceId === emphasisId || link.targetId === emphasisId,
        )
        .style("opacity", (link) => {
          if (!emphasisId) return edgeOpacity(link);
          if (link.sourceId === emphasisId || link.targetId === emphasisId) {
            return 0.72 + link.weight * 0.25;
          }
          return stronglyDim ? 0.025 : 0.06;
        });

      updateLabels(transformRef.current.k);
    };

    const fitNodes = (subset: GraphSimulationNode[], maximumScale = 1.65) => {
      animateTransform(fitTransform(subset, width, height, maximumScale));
    };

    updateLabelsRef.current = updateLabels;
    updateEmphasisRef.current = updateEmphasis;
    fitRef.current = () => fitNodes(nodes);
    reheatRef.current = () => simulation.alpha(0.72).restart();
    let resetFitTimer = 0;
    let focusFitTimer = 0;
    resetRef.current = () => {
      hoveredRef.current = null;
      focusedRef.current = null;
      setFocusedNodeId(null);
      hideTooltip();
      updateEmphasis();
      simulation.alpha(0.34).restart();
      window.clearTimeout(resetFitTimer);
      resetFitTimer = window.setTimeout(
        () => fitNodes(nodes),
        reducedMotionRef.current ? 0 : 140,
      );
    };
    focusRef.current = (id: string) => {
      const node = nodes.find((item) => item.id === id);
      if (!node) return;
      const neighbors = [...(adjacency.get(id) ?? [])];
      const neighborhoodIds = new Set([id, ...neighbors]);
      const neighborhoodNodes = nodes.filter((item) => neighborhoodIds.has(item.id));
      focusedRef.current = id;
      setFocusedNodeId(id);
      selectedRef.current = id;
      onSelectRef.current(id);
      onFocusNeighborhoodRef.current?.(id, neighbors);
      updateEmphasis();
      simulation.alpha(0.22).restart();
      window.clearTimeout(focusFitTimer);
      focusFitTimer = window.setTimeout(
        () => fitNodes(neighborhoodNodes, neighborhoodNodes.length === 1 ? 1.45 : 2.25),
        reducedMotionRef.current ? 0 : 80,
      );
    };

    nodeSelection
      .on("pointerenter.knowledge-graph", (event: PointerEvent, node) => {
        hoveredRef.current = node.id;
        showTooltip(event, node);
        updateEmphasis();
      })
      .on("pointermove.knowledge-graph", (event: PointerEvent, node) => showTooltip(event, node))
      .on("pointerleave.knowledge-graph", () => {
        hoveredRef.current = null;
        hideTooltip();
        updateEmphasis();
      })
      .on("focus.knowledge-graph", (_, node) => {
        hoveredRef.current = node.id;
        updateEmphasis();
      })
      .on("blur.knowledge-graph", () => {
        hoveredRef.current = null;
        updateEmphasis();
      })
      .on("click.knowledge-graph", (event: MouseEvent, node) => {
        event.stopPropagation();
        focusedRef.current = null;
        setFocusedNodeId(null);
        selectedRef.current = node.id;
        onSelectRef.current(node.id);
        updateEmphasis();
      })
      .on("dblclick.knowledge-graph", (event: MouseEvent, node) => {
        event.preventDefault();
        event.stopPropagation();
        focusRef.current(node.id);
      })
      .on("keydown.knowledge-graph", (event: KeyboardEvent, node) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (event.shiftKey) focusRef.current(node.id);
          else {
            selectedRef.current = node.id;
            onSelectRef.current(node.id);
            updateEmphasis();
          }
        }
      });

    const dragBehavior = drag<SVGGElement, GraphSimulationNode>()
      .clickDistance(3)
      .on("start.knowledge-graph", function handleDragStart(event, node) {
        event.sourceEvent?.stopPropagation();
        if (!event.active) simulation.alphaTarget(0.16).restart();
        node.fx = node.x;
        node.fy = node.y;
        select(this).classed(styles.dragging, true);
      })
      .on("drag.knowledge-graph", (event, node) => {
        node.fx = event.x;
        node.fy = event.y;
      })
      .on("end.knowledge-graph", function handleDragEnd(event, node) {
        if (!event.active) simulation.alphaTarget(0);
        node.fx = null;
        node.fy = null;
        positionCache.set(node.id, { x: node.x ?? event.x, y: node.y ?? event.y });
        select(this).classed(styles.dragging, false);
      });
    nodeSelection.call(dragBehavior);

    updateEmphasis();
    let autoFitTimer = 0;
    if (autoFitOnChange && nodes.length) {
      autoFitTimer = window.setTimeout(
        () => fitNodes(nodes),
        reducedMotionRef.current ? 0 : 260,
      );
    }

    return () => {
      window.clearTimeout(autoFitTimer);
      window.clearTimeout(resetFitTimer);
      window.clearTimeout(focusFitTimer);
      simulation.stop();
      nodes.forEach((node) => {
        positionCache.set(node.id, {
          x: node.x ?? width / 2,
          y: node.y ?? height / 2,
        });
      });
      nodeSelection.on(".knowledge-graph", null);
      if (simulationRef.current === simulation) simulationRef.current = null;
    };
  }, [animateTransform, autoFitOnChange, filterKey, graph, layoutRevision, size]);

  useEffect(() => {
    selectedRef.current = selected;
    updateEmphasisRef.current();
  }, [selected]);

  return (
    <div
      ref={rootRef}
      className={joinClassNames("graph-stage", styles.root, className)}
      data-empty={visibleNodeCount === 0 ? "true" : "false"}
    >
      <svg
        ref={svgRef}
        className={styles.svg}
        viewBox={`0 0 ${size.width} ${size.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="group"
        aria-label={`Knowledge graph with ${visibleNodeCount} nodes and ${visibleLinkCount} links. Scroll to zoom, drag the background to pan, and double-click a node to focus its neighborhood.`}
      >
        <g ref={viewportRef}>
          <g ref={linkLayerRef} className={styles.links} />
          <g ref={nodeLayerRef} className={styles.nodes} />
        </g>
      </svg>

      <div className={styles.controls} role="toolbar" aria-label="Graph view controls">
        <button type="button" onClick={() => zoomBy(1.32)} title="Zoom in" aria-label="Zoom in">
          <ZoomIn size={15} />
        </button>
        <button type="button" onClick={() => zoomBy(1 / 1.32)} title="Zoom out" aria-label="Zoom out">
          <ZoomOut size={15} />
        </button>
        <span aria-hidden="true" />
        <button type="button" onClick={() => fitRef.current()} title="Fit graph" aria-label="Fit graph">
          <Maximize2 size={14} />
        </button>
        <button
          type="button"
          onClick={() => resetRef.current()}
          title="Reset graph focus"
          aria-label="Reset graph focus and view"
        >
          <RotateCcw size={14} />
        </button>
      </div>

      {focusedNodeId ? (
        <button
          type="button"
          className={styles.focusNotice}
          onClick={() => resetRef.current()}
          title="Show the full graph"
        >
          <Focus size={12} /> Neighborhood focus · clear
        </button>
      ) : null}

      <div className={styles.hint} aria-hidden="true">
        <span>{visibleNodeCount} nodes</span>
        <i />
        <span>{visibleLinkCount} links</span>
        <i />
        <span>drag to pan · scroll to zoom</span>
      </div>

      <div className={styles.edgeLegend} aria-label="Relationship types">
        <span data-kind="semantic"><i /> semantic</span>
        <span data-kind="explicit"><i /> explicit</span>
        <span data-kind="co-occurrence"><i /> repeated use</span>
      </div>

      <div ref={tooltipRef} className={styles.tooltip} role="tooltip" data-visible="false">
        <span ref={tooltipTitleRef} className={styles.tooltipTitle} />
        <span ref={tooltipMetaRef} className={styles.tooltipMeta} />
      </div>

      {visibleNodeCount === 0 ? (
        <div className={styles.empty} role="status">
          <span>No visible knowledge</span>
          <small>Enable at least one node type to rebuild the graph.</small>
        </div>
      ) : null}
    </div>
  );
});

KnowledgeGraphCanvas.displayName = "KnowledgeGraphCanvas";

export default KnowledgeGraphCanvas;
