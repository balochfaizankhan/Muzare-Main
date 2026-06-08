import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Droplets, FileText, FlaskConical, Layers, MapPinned, Plus, Save, SprayCan, Upload } from "lucide-react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import {
  createFarmOperationResource,
  fetchBootstrap,
  fetchFarmOperationLogs,
  fetchFarmOperationsDashboard,
  fetchFarmOperationsProducts,
  updateFarmOperationResource,
  type FarmMapFeature,
  type FarmPlot,
  type IrrigationLine,
  type OperationActivityType,
  type OperationLog,
} from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { hasPermission } from "../../lib/permissions";

type Mode = "builder" | "live";
type Selected = { kind: "plot"; id: string } | { kind: "valve"; id: string } | null;
type LayerKey = "plots" | "irrigation" | "valves" | "fertilizerStatus" | "pesticideStatus" | "irrigationStatus";

const emptyFeature = {
  seasonId: null,
  featureType: "plot",
  featureCode: "",
  featureName: "",
  geojsonText: "",
  linkedPlotId: "",
  linkedIrrigationLineId: "",
  linkedValveId: "",
  displayOrder: 0,
  active: true,
};
const emptyPlot = { seasonId: null, plotCode: "", plotName: "", variety: "", treeCount: "", area: "", notes: "", geoFeatureId: "", active: true };
const emptyLine = { seasonId: null, lineCode: "", lineName: "", description: "", geoFeatureId: "", active: true };
const emptyValve = { seasonId: null, valveCode: "", valveName: "", irrigationLineId: "", plotId: "", estimatedTreeCount: "", notes: "", geoFeatureId: "", active: true };
const emptyLog = {
  seasonId: "",
  plotId: "",
  irrigationLineId: "",
  valveId: "",
  activityType: "irrigation" as OperationActivityType,
  activityCategory: "",
  productId: "",
  productNameText: "",
  operationDate: new Date().toISOString().slice(0, 10),
  startTime: "",
  endTime: "",
  durationMinutes: "",
  qtyPerTree: "",
  totalQty: "",
  unit: "",
  treeCountCovered: "",
  performedBy: "",
  labourTeamId: "",
  remarks: "",
};
type FeatureForm = Omit<typeof emptyFeature, "seasonId"> & { seasonId: string | null };
type PlotForm = Omit<typeof emptyPlot, "seasonId"> & { seasonId: string | null };
type LineForm = Omit<typeof emptyLine, "seasonId"> & { seasonId: string | null };
type ValveForm = Omit<typeof emptyValve, "seasonId"> & { seasonId: string | null };
const statusColors: Record<string, string> = {
  ok: "#16a34a",
  due_soon: "#eab308",
  overdue: "#dc2626",
  completed_today: "#2563eb",
  none: "#9ca3af",
};
const activityOptions: OperationActivityType[] = ["irrigation", "fertilizer", "pesticide", "pruning", "thinning", "pollination", "harvesting", "maintenance", "other"];

function normalizeFeature(feature: FarmMapFeature, statusByPlot: Map<string, Record<string, string>>, statusLayer: OperationActivityType) {
  const geojson = feature.geojson.type === "Feature"
    ? feature.geojson
    : { type: "Feature", geometry: feature.geojson, properties: {} };
  const status = feature.linkedPlotId ? statusByPlot.get(feature.linkedPlotId)?.[statusLayer] ?? "none" : "none";
  return {
    ...geojson,
    id: feature.id,
    properties: {
      ...((geojson.properties as Record<string, unknown>) ?? {}),
      featureId: feature.id,
      featureType: feature.featureType,
      linkedPlotId: feature.linkedPlotId,
      linkedValveId: feature.linkedValveId,
      status,
      fillColor: feature.featureType === "plot" ? statusColors[status] : "#2e7d32",
    },
  };
}

function firstCoordinate(features: FarmMapFeature[]) {
  for (const feature of features) {
    const raw = feature.geojson.type === "Feature" ? (feature.geojson.geometry as Record<string, unknown> | undefined) : feature.geojson;
    const coords = raw?.coordinates as unknown;
    if (Array.isArray(coords)) {
      const walk = (value: unknown): [number, number] | null => Array.isArray(value) && typeof value[0] === "number" && typeof value[1] === "number"
        ? [value[0], value[1]]
        : Array.isArray(value) ? value.map(walk).find(Boolean) ?? null : null;
      const point = walk(coords);
      if (point) return point;
    }
  }
  return null;
}

function MapCanvas({
  dashboard,
  activeStatus,
  layers,
  onSelect,
}: {
  dashboard: ReturnType<typeof useDashboardData>["dashboard"];
  activeStatus: OperationActivityType;
  layers: Record<LayerKey, boolean>;
  onSelect: (selection: Selected) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const statusByPlot = useMemo(() => new Map(dashboard?.plotStatusSummary.map((item) => [item.plotId, item.statuses]) ?? []), [dashboard?.plotStatusSummary]);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const fallback = firstCoordinate(dashboard?.features ?? []);
    const center: [number, number] = dashboard?.farmMap
      ? [Number(dashboard.farmMap.centerLng), Number(dashboard.farmMap.centerLat)]
      : fallback ?? [46.6753, 24.7136];
    mapRef.current = new maplibregl.Map({
      container: containerRef.current,
      center,
      zoom: dashboard?.farmMap ? Number(dashboard.farmMap.defaultZoom) : 15,
      style: {
        version: 8,
        sources: {
          satellite: {
            type: "raster",
            tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
            tileSize: 256,
            attribution: "Tiles Esri, Maxar, Earthstar Geographics, and the GIS User Community",
          },
        },
        layers: [{ id: "satellite", type: "raster", source: "satellite" }],
      },
    });
    mapRef.current.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    mapRef.current.on("click", "plot-fill", (event) => {
      const id = event.features?.[0]?.properties?.linkedPlotId as string | undefined;
      if (id) onSelect({ kind: "plot", id });
    });
    mapRef.current.on("click", "valve-points", (event) => {
      const id = event.features?.[0]?.properties?.linkedValveId as string | undefined;
      if (id) onSelect({ kind: "valve", id });
    });
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [dashboard?.farmMap, dashboard?.features, onSelect]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !dashboard) return;
    const render = () => {
      const allFeatures = dashboard.features.map((feature) => normalizeFeature(feature, statusByPlot, activeStatus));
      const collection = { type: "FeatureCollection", features: allFeatures };
      if (map.getSource("farm-features")) {
        (map.getSource("farm-features") as maplibregl.GeoJSONSource).setData(collection as never);
      } else {
        map.addSource("farm-features", { type: "geojson", data: collection as never });
        map.addLayer({ id: "boundary-line", type: "line", source: "farm-features", filter: ["==", ["get", "featureType"], "farm_boundary"], paint: { "line-color": "#ffffff", "line-width": 4, "line-opacity": 0.9 } });
        map.addLayer({ id: "plot-fill", type: "fill", source: "farm-features", filter: ["==", ["get", "featureType"], "plot"], paint: { "fill-color": ["get", "fillColor"], "fill-opacity": 0.34 } });
        map.addLayer({ id: "plot-line", type: "line", source: "farm-features", filter: ["==", ["get", "featureType"], "plot"], paint: { "line-color": "#f8fafc", "line-width": 2 } });
        map.addLayer({ id: "irrigation-lines", type: "line", source: "farm-features", filter: ["==", ["get", "featureType"], "irrigation_line"], paint: { "line-color": "#38bdf8", "line-width": 4 } });
        map.addLayer({ id: "valve-points", type: "circle", source: "farm-features", filter: ["==", ["get", "featureType"], "valve"], paint: { "circle-radius": 7, "circle-color": "#2563eb", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
      }
      map.setLayoutProperty("plot-fill", "visibility", layers.plots ? "visible" : "none");
      map.setLayoutProperty("plot-line", "visibility", layers.plots ? "visible" : "none");
      map.setLayoutProperty("irrigation-lines", "visibility", layers.irrigation ? "visible" : "none");
      map.setLayoutProperty("valve-points", "visibility", layers.valves ? "visible" : "none");
    };
    if (map.loaded()) render();
    else map.once("load", render);
  }, [activeStatus, dashboard, layers.irrigation, layers.plots, layers.valves, statusByPlot]);

  return <div className="farm-map-canvas" ref={containerRef} />;
}

function useDashboardData(workspaceId: string, farmId: string, seasonId?: string | null) {
  const { token } = useAuth();
  const query = useQuery({
    queryKey: ["farm-operations-dashboard", workspaceId, farmId, seasonId],
    queryFn: () => fetchFarmOperationsDashboard(token!, workspaceId, farmId, seasonId),
    enabled: Boolean(token && workspaceId && farmId),
  });
  return { ...query, dashboard: query.data };
}

function StatusBadges({ statuses }: { statuses?: Record<string, string> }) {
  return <div className="farm-status-badges">
    {["irrigation", "fertilizer", "pesticide"].map((activity) => <span key={activity} style={{ borderColor: statusColors[statuses?.[activity] ?? "none"] }}>{activity}: {String(statuses?.[activity] ?? "none").replaceAll("_", " ")}</span>)}
  </div>;
}

function OperationLogForm({
  dashboard,
  products,
  initial,
  onSubmit,
  pending,
}: {
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>;
  products: Awaited<ReturnType<typeof fetchFarmOperationsProducts>>["records"];
  initial: typeof emptyLog;
  onSubmit: (input: typeof emptyLog) => void;
  pending: boolean;
}) {
  const [form, setForm] = useState(initial);
  useEffect(() => setForm(initial), [initial]);
  useEffect(() => {
    const trees = Number(form.treeCountCovered || dashboard.plots.find((plot) => plot.id === form.plotId)?.treeCount || 0);
    const qty = Number(form.qtyPerTree || 0);
    if (trees > 0 && qty > 0 && !form.totalQty) setForm((current) => ({ ...current, totalQty: String(Number((trees * qty).toFixed(4))) }));
  }, [dashboard.plots, form.plotId, form.qtyPerTree, form.totalQty, form.treeCountCovered]);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSubmit(form);
  };
  const activityProducts = products.filter((product) => product.productType === form.activityType || product.productType === "other");
  return <form className="farm-operation-form" onSubmit={submit}>
    <select value={form.activityType} onChange={(event) => setForm({ ...form, activityType: event.target.value as OperationActivityType, productId: "" })}>{activityOptions.map((item) => <option key={item}>{item}</option>)}</select>
    <input type="date" value={form.operationDate} onChange={(event) => setForm({ ...form, operationDate: event.target.value })} />
    <select value={form.plotId} onChange={(event) => setForm({ ...form, plotId: event.target.value })}><option value="">Plot</option>{dashboard.plots.map((plot) => <option key={plot.id} value={plot.id}>{plot.plotCode} {plot.plotName ?? ""}</option>)}</select>
    <select value={form.irrigationLineId} onChange={(event) => setForm({ ...form, irrigationLineId: event.target.value })}><option value="">Irrigation line</option>{dashboard.irrigationLines.map((line) => <option key={line.id} value={line.id}>{line.lineCode} {line.lineName ?? ""}</option>)}</select>
    <select value={form.valveId} onChange={(event) => setForm({ ...form, valveId: event.target.value })}><option value="">Valve</option>{dashboard.valves.map((valve) => <option key={valve.id} value={valve.id}>{valve.valveCode} {valve.valveName ?? ""}</option>)}</select>
    {(form.activityType === "irrigation") && <><input type="time" value={form.startTime} onChange={(event) => setForm({ ...form, startTime: event.target.value })} /><input type="time" value={form.endTime} onChange={(event) => setForm({ ...form, endTime: event.target.value })} /><input inputMode="numeric" placeholder="Duration minutes" value={form.durationMinutes} onChange={(event) => setForm({ ...form, durationMinutes: event.target.value })} /></>}
    {(form.activityType === "fertilizer" || form.activityType === "pesticide") && <><input placeholder="Category" value={form.activityCategory} onChange={(event) => setForm({ ...form, activityCategory: event.target.value })} /><select value={form.productId} onChange={(event) => setForm({ ...form, productId: event.target.value })}><option value="">Product</option>{activityProducts.map((product) => <option key={product.id} value={product.id}>{product.productName}</option>)}</select><input placeholder="Product text" value={form.productNameText} onChange={(event) => setForm({ ...form, productNameText: event.target.value })} /></>}
    <input inputMode="decimal" placeholder="Qty per tree" value={form.qtyPerTree} onChange={(event) => setForm({ ...form, qtyPerTree: event.target.value, totalQty: "" })} />
    <input inputMode="decimal" placeholder="Total quantity" value={form.totalQty} onChange={(event) => setForm({ ...form, totalQty: event.target.value })} />
    <input placeholder="Unit" value={form.unit} onChange={(event) => setForm({ ...form, unit: event.target.value })} />
    <input inputMode="numeric" placeholder="Trees covered" value={form.treeCountCovered} onChange={(event) => setForm({ ...form, treeCountCovered: event.target.value, totalQty: "" })} />
    <input placeholder="Performed by" value={form.performedBy} onChange={(event) => setForm({ ...form, performedBy: event.target.value })} />
    <textarea placeholder="Remarks" value={form.remarks} onChange={(event) => setForm({ ...form, remarks: event.target.value })} />
    <button type="submit" disabled={pending}><Save size={16} />Log operation</button>
  </form>;
}

function SideDrawer({
  selected,
  dashboard,
  logs,
  onClose,
  onQuickLog,
}: {
  selected: Selected;
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>;
  logs: OperationLog[];
  onClose: () => void;
  onQuickLog: (activity: OperationActivityType, selection: Selected) => void;
}) {
  if (!selected) return null;
  const plot = selected.kind === "plot" ? dashboard.plots.find((item) => item.id === selected.id) : null;
  const valve = selected.kind === "valve" ? dashboard.valves.find((item) => item.id === selected.id) : null;
  const linkedPlot = plot ?? dashboard.plots.find((item) => item.id === valve?.plotId);
  const linkedValves = linkedPlot ? dashboard.valves.filter((item) => item.plotId === linkedPlot.id) : [];
  const line = dashboard.irrigationLines.find((item) => item.id === valve?.irrigationLineId);
  const statuses = linkedPlot ? dashboard.plotStatusSummary.find((item) => item.plotId === linkedPlot.id)?.statuses : undefined;
  const scopedLogs = logs.filter((item) => selected.kind === "plot" ? item.plotId === selected.id : item.valveId === selected.id).slice(0, 12);
  return <aside className="farm-map-drawer">
    <button className="farm-map-drawer__close" type="button" onClick={onClose}>Close</button>
    {plot && <><h2>{plot.plotCode} {plot.plotName ?? ""}</h2><p>{plot.variety ?? "Variety not recorded"} | {plot.treeCount ?? 0} trees</p><StatusBadges statuses={statuses} /></>}
    {valve && <><h2>{valve.valveCode} {valve.valveName ?? ""}</h2><p>{line?.lineName ?? line?.lineCode ?? "No line"} | {linkedPlot?.plotName ?? linkedPlot?.plotCode ?? "No plot"}</p><StatusBadges statuses={statuses} /></>}
    <div className="farm-quick-actions">
      <button type="button" onClick={() => onQuickLog("irrigation", selected)}><Droplets size={17} />Log irrigation</button>
      <button type="button" onClick={() => onQuickLog("fertilizer", selected)}><FlaskConical size={17} />Log fertilizer</button>
      <button type="button" onClick={() => onQuickLog("pesticide", selected)}><SprayCan size={17} />Log spray</button>
      <button type="button" onClick={() => onQuickLog("maintenance", selected)}><FileText size={17} />Report issue</button>
    </div>
    <dl className="farm-map-facts">
      <div><dt>Linked valves</dt><dd>{linkedValves.map((item) => item.valveCode).join(", ") || "-"}</dd></div>
      <div><dt>Linked lines</dt><dd>{[...new Set(linkedValves.map((item) => dashboard.irrigationLines.find((lineItem) => lineItem.id === item.irrigationLineId)?.lineCode).filter(Boolean))].join(", ") || line?.lineCode || "-"}</dd></div>
      <div><dt>Pending work</dt><dd>{dashboard.dueWorkList.filter((item) => item.plotId === linkedPlot?.id).map((item) => `${item.activityType} ${item.status}`).join(", ") || "-"}</dd></div>
    </dl>
    <h3>Operation history</h3>
    <div className="farm-log-list">{scopedLogs.map((log) => <article key={log.id}><strong>{log.activityType}</strong><span>{log.operationDate} {log.totalQty ? `| ${log.totalQty} ${log.unit ?? ""}` : ""}</span><small>{log.performedBy || log.remarks || "-"}</small></article>)}</div>
  </aside>;
}

export function FarmOperationsMap({ mode }: { mode: Mode }) {
  const { user, token } = useAuth();
  const params = useParams();
  const queryClient = useQueryClient();
  const workspaceId = params.workspaceId ?? user?.workspaceId ?? "";
  const bootstrap = useQuery({ queryKey: ["bootstrap", token], queryFn: () => fetchBootstrap(token!), enabled: Boolean(token) });
  const farmId = params.farmId ?? bootstrap.data?.activeFarmId ?? "";
  const activeSeasonId = bootstrap.data?.activeSeasonId ?? null;
  const dashboardQuery = useDashboardData(workspaceId, farmId, activeSeasonId);
  const products = useQuery({ queryKey: ["farm-products", workspaceId, farmId], queryFn: () => fetchFarmOperationsProducts(token!, workspaceId, farmId), enabled: Boolean(token && workspaceId && farmId) });
  const logsQuery = useQuery({ queryKey: ["farm-operation-logs", workspaceId, farmId, activeSeasonId], queryFn: () => fetchFarmOperationLogs(token!, workspaceId, { farmId, seasonId: activeSeasonId }), enabled: Boolean(token && workspaceId && farmId) });
  const canManage = Boolean(user && hasPermission(user, "MANAGE_RECORDS", workspaceId));
  const [selected, setSelected] = useState<Selected>(null);
  const [activeStatus, setActiveStatus] = useState<OperationActivityType>("irrigation");
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ plots: true, irrigation: true, valves: true, fertilizerStatus: true, pesticideStatus: true, irrigationStatus: true });
  const [featureForm, setFeatureForm] = useState<FeatureForm>(emptyFeature);
  const [plotForm, setPlotForm] = useState<PlotForm>(emptyPlot);
  const [lineForm, setLineForm] = useState<LineForm>(emptyLine);
  const [valveForm, setValveForm] = useState<ValveForm>(emptyValve);
  const [mapForm, setMapForm] = useState({ mapName: "Farm satellite operations map", centerLat: "24.7136", centerLng: "46.6753", defaultZoom: "16", notes: "" });
  const [logForm, setLogForm] = useState(emptyLog);
  const [showLog, setShowLog] = useState(false);
  const dashboard = dashboardQuery.dashboard;
  useEffect(() => {
    if (activeSeasonId) {
      setLogForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setFeatureForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setPlotForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setLineForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setValveForm((current) => ({ ...current, seasonId: activeSeasonId }));
    }
  }, [activeSeasonId]);
  useEffect(() => {
    if (dashboard?.farmMap) setMapForm({ mapName: dashboard.farmMap.mapName, centerLat: dashboard.farmMap.centerLat, centerLng: dashboard.farmMap.centerLng, defaultZoom: dashboard.farmMap.defaultZoom, notes: dashboard.farmMap.notes ?? "" });
  }, [dashboard?.farmMap]);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["farm-operations-dashboard", workspaceId, farmId] }),
      queryClient.invalidateQueries({ queryKey: ["farm-operation-logs", workspaceId, farmId] }),
    ]);
  };
  const saveResource = useMutation({
    mutationFn: ({ resource, input, id }: { resource: string; input: unknown; id?: string }) => id
      ? updateFarmOperationResource(token!, workspaceId, farmId, resource, id, input)
      : createFarmOperationResource(token!, workspaceId, farmId, resource, input),
    onSuccess: refresh,
  });
  const quickLog = (activity: OperationActivityType, selection: Selected) => {
    const valve = selection?.kind === "valve" ? dashboard?.valves.find((item) => item.id === selection.id) : null;
    const plot = selection?.kind === "plot" ? dashboard?.plots.find((item) => item.id === selection.id) : dashboard?.plots.find((item) => item.id === valve?.plotId);
    setLogForm({ ...emptyLog, seasonId: activeSeasonId ?? "", activityType: activity, plotId: plot?.id ?? "", valveId: valve?.id ?? "", irrigationLineId: valve?.irrigationLineId ?? "", treeCountCovered: String(plot?.treeCount ?? valve?.estimatedTreeCount ?? "") });
    setShowLog(true);
  };
  const submitLog = (input: typeof emptyLog) => saveResource.mutate({
    resource: "operation-logs",
    input: {
      ...input,
      durationMinutes: input.durationMinutes || null,
      qtyPerTree: input.qtyPerTree || null,
      totalQty: input.totalQty || null,
      treeCountCovered: input.treeCountCovered || null,
    },
  }, { onSuccess: () => setShowLog(false) });
  const saveFeature = (event: FormEvent) => {
    event.preventDefault();
    let geojson: Record<string, unknown>;
    try {
      geojson = JSON.parse(featureForm.geojsonText) as Record<string, unknown>;
    } catch {
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: "GeoJSON is not valid JSON." }));
      return;
    }
    saveResource.mutate({ resource: "features", input: { ...featureForm, geojson, styleJson: null, geojsonText: undefined } });
  };
  const saveMap = (event: FormEvent) => {
    event.preventDefault();
    const input = { ...mapForm, seasonId: activeSeasonId, baseMapProvider: "maplibre_satellite" };
    saveResource.mutate({ resource: "maps", id: dashboard?.farmMap?.id, input });
  };
  const logs = logsQuery.data?.records ?? [];
  const selectedStatus = selected?.kind === "plot" ? dashboard?.plotStatusSummary.find((item) => item.plotId === selected.id)?.statuses : undefined;
  const totalTrees = dashboard?.plots.reduce((sum, plot) => sum + (plot.treeCount ?? 0), 0) ?? 0;

  return <div className="dashboard-page farm-map-page">
    <SubpageHeader title={mode === "builder" ? "Farm Map Builder" : "Live Farm Operations Map"} />
    <main className="subpage farm-map-shell">
      {!farmId && <p className="error">Open this page from a farm card so Muzare knows which farm to map.</p>}
      {dashboardQuery.isLoading && <p className="context-message">Loading farm map...</p>}
      {dashboardQuery.isError && <p className="error">{dashboardQuery.error.message}</p>}
      {dashboard && <>
        <section className="farm-map-topbar">
          <article><span>Total plots</span><strong>{dashboard.plots.length}</strong></article>
          <article><span>Total trees</span><strong>{formatNumber(totalTrees)}</strong></article>
          <article><span>Irrigation overdue</span><strong>{dashboard.plotStatusSummary.filter((item) => item.statuses.irrigation === "overdue").length}</strong></article>
          <article><span>Fertilizer due</span><strong>{dashboard.plotStatusSummary.filter((item) => ["overdue", "due_soon"].includes(item.statuses.fertilizer)).length}</strong></article>
          <article><span>Pesticide due</span><strong>{dashboard.plotStatusSummary.filter((item) => ["overdue", "due_soon"].includes(item.statuses.pesticide)).length}</strong></article>
          <article><span>Completed today</span><strong>{dashboard.completedTodayCount}</strong></article>
        </section>
        <section className="farm-map-workspace">
          <div className="farm-map-panel">
            <div className="farm-map-toolbar">
              <div className="farm-map-layer-toggles">
                {(["plots", "irrigation", "valves"] as LayerKey[]).map((key) => <button className={layers[key] ? "is-active" : ""} type="button" key={key} onClick={() => setLayers({ ...layers, [key]: !layers[key] })}><Layers size={15} />{key}</button>)}
              </div>
              <div className="farm-map-layer-toggles">
                {(["irrigation", "fertilizer", "pesticide"] as OperationActivityType[]).map((key) => <button className={activeStatus === key ? "is-active" : ""} type="button" key={key} onClick={() => setActiveStatus(key)}>{key}</button>)}
              </div>
            </div>
            <MapCanvas dashboard={dashboard} activeStatus={activeStatus} layers={layers} onSelect={setSelected} />
          </div>
          <aside className="farm-map-side">
            <div className="farm-map-actions">
              <Link to={`/workspace/${workspaceId}/farms/${farmId}/operations-map`}><MapPinned size={16} />Live map</Link>
              <Link to={`/workspace/${workspaceId}/farms/${farmId}/map-builder`}><Upload size={16} />Builder</Link>
              <button type="button" onClick={() => quickLog("irrigation", selected)}><Droplets size={16} />Log irrigation</button>
              <button type="button" onClick={() => quickLog("fertilizer", selected)}><FlaskConical size={16} />Log fertilizer</button>
              <button type="button" onClick={() => quickLog("pesticide", selected)}><SprayCan size={16} />Log spray</button>
            </div>
            {selectedStatus && <StatusBadges statuses={selectedStatus} />}
            <section className="farm-due-panel">
              <h2><CalendarClock size={17} />Due work</h2>
              {dashboard.dueWorkList.slice(0, 10).map((item) => {
                const plot = dashboard.plots.find((row) => row.id === item.plotId);
                return <article key={`${item.plotId}:${item.activityType}`}><strong>{plot?.plotCode ?? "Plot"}</strong><span>{item.activityType} {item.status.replaceAll("_", " ")}</span></article>;
              })}
              {!dashboard.dueWorkList.length && <p>No due work from current rules.</p>}
            </section>
          </aside>
        </section>
        {mode === "builder" && canManage && <section className="farm-builder-grid">
          <form className="record-panel farm-builder-form" onSubmit={saveMap}>
            <h2>Map setup</h2>
            <input placeholder="Map name" value={mapForm.mapName} onChange={(event) => setMapForm({ ...mapForm, mapName: event.target.value })} />
            <input inputMode="decimal" placeholder="Center latitude" value={mapForm.centerLat} onChange={(event) => setMapForm({ ...mapForm, centerLat: event.target.value })} />
            <input inputMode="decimal" placeholder="Center longitude" value={mapForm.centerLng} onChange={(event) => setMapForm({ ...mapForm, centerLng: event.target.value })} />
            <input inputMode="decimal" placeholder="Default zoom" value={mapForm.defaultZoom} onChange={(event) => setMapForm({ ...mapForm, defaultZoom: event.target.value })} />
            <textarea placeholder="Notes" value={mapForm.notes} onChange={(event) => setMapForm({ ...mapForm, notes: event.target.value })} />
            <button type="submit"><Save size={16} />Save map</button>
          </form>
          <form className="record-panel farm-builder-form" onSubmit={saveFeature}>
            <h2>GeoJSON feature</h2>
            <select value={featureForm.featureType} onChange={(event) => setFeatureForm({ ...featureForm, featureType: event.target.value })}>{["farm_boundary", "plot", "irrigation_line", "valve", "landmark", "other"].map((item) => <option key={item}>{item}</option>)}</select>
            <input placeholder="Feature code" value={featureForm.featureCode} onChange={(event) => setFeatureForm({ ...featureForm, featureCode: event.target.value })} />
            <input required placeholder="Feature name" value={featureForm.featureName} onChange={(event) => setFeatureForm({ ...featureForm, featureName: event.target.value })} />
            <textarea required placeholder='Paste GeoJSON geometry or Feature' value={featureForm.geojsonText} onChange={(event) => setFeatureForm({ ...featureForm, geojsonText: event.target.value })} />
            <select value={featureForm.linkedPlotId} onChange={(event) => setFeatureForm({ ...featureForm, linkedPlotId: event.target.value })}><option value="">Link plot later</option>{dashboard.plots.map((plot) => <option key={plot.id} value={plot.id}>{plot.plotCode}</option>)}</select>
            <select value={featureForm.linkedIrrigationLineId} onChange={(event) => setFeatureForm({ ...featureForm, linkedIrrigationLineId: event.target.value })}><option value="">Link line later</option>{dashboard.irrigationLines.map((line) => <option key={line.id} value={line.id}>{line.lineCode}</option>)}</select>
            <select value={featureForm.linkedValveId} onChange={(event) => setFeatureForm({ ...featureForm, linkedValveId: event.target.value })}><option value="">Link valve later</option>{dashboard.valves.map((valve) => <option key={valve.id} value={valve.id}>{valve.valveCode}</option>)}</select>
            <button type="submit"><Plus size={16} />Import feature</button>
          </form>
          <BuilderForms dashboard={dashboard} plotForm={plotForm} setPlotForm={setPlotForm} lineForm={lineForm} setLineForm={setLineForm} valveForm={valveForm} setValveForm={setValveForm} saveResource={saveResource.mutate} />
        </section>}
        {showLog && <section className="record-panel farm-log-panel">
          <header><h2>Operation logging</h2><button type="button" onClick={() => setShowLog(false)}>Close</button></header>
          <OperationLogForm dashboard={dashboard} products={products.data?.records ?? []} initial={logForm} onSubmit={submitLog} pending={saveResource.isPending} />
        </section>}
        <section className="record-panel farm-logs-report">
          <h2>Operation logs report</h2>
          <div className="attendance-import-table-wrap report-wide-table">
            <table className="report-data-table"><thead><tr><th>Date</th><th>Activity</th><th>Plot</th><th>Valve</th><th>Product</th><th>Qty</th><th>Performed by</th><th>Remarks</th></tr></thead><tbody>
              {logs.map((log) => <tr key={log.id}><td>{log.operationDate}</td><td>{log.activityType}</td><td>{dashboard.plots.find((plot) => plot.id === log.plotId)?.plotCode ?? "-"}</td><td>{dashboard.valves.find((valve) => valve.id === log.valveId)?.valveCode ?? "-"}</td><td>{products.data?.records.find((product) => product.id === log.productId)?.productName ?? log.productNameText ?? "-"}</td><td>{log.totalQty ?? "-"} {log.unit ?? ""}</td><td>{log.performedBy ?? "-"}</td><td>{log.remarks ?? "-"}</td></tr>)}
            </tbody></table>
          </div>
        </section>
        <SideDrawer selected={selected} dashboard={dashboard} logs={logs} onClose={() => setSelected(null)} onQuickLog={quickLog} />
      </>}
    </main>
  </div>;
}

function BuilderForms({
  dashboard,
  plotForm,
  setPlotForm,
  lineForm,
  setLineForm,
  valveForm,
  setValveForm,
  saveResource,
}: {
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>;
  plotForm: PlotForm;
  setPlotForm: (form: PlotForm) => void;
  lineForm: LineForm;
  setLineForm: (form: LineForm) => void;
  valveForm: ValveForm;
  setValveForm: (form: ValveForm) => void;
  saveResource: (input: { resource: string; input: unknown }) => void;
}) {
  const numeric = (value: string) => value ? Number(value) : null;
  const features = dashboard.features;
  const submit = (resource: string, input: unknown) => (event: FormEvent) => {
    event.preventDefault();
    saveResource({ resource, input });
  };
  return <>
    <form className="record-panel farm-builder-form" onSubmit={submit("plots", { ...plotForm, treeCount: numeric(plotForm.treeCount), area: numeric(plotForm.area) })}>
      <h2>Plot record</h2><input required placeholder="Plot code" value={plotForm.plotCode} onChange={(event) => setPlotForm({ ...plotForm, plotCode: event.target.value })} /><input placeholder="Plot name" value={plotForm.plotName} onChange={(event) => setPlotForm({ ...plotForm, plotName: event.target.value })} /><input placeholder="Variety" value={plotForm.variety} onChange={(event) => setPlotForm({ ...plotForm, variety: event.target.value })} /><input inputMode="numeric" placeholder="Tree count" value={plotForm.treeCount} onChange={(event) => setPlotForm({ ...plotForm, treeCount: event.target.value })} /><select value={plotForm.geoFeatureId} onChange={(event) => setPlotForm({ ...plotForm, geoFeatureId: event.target.value })}><option value="">Link feature later</option>{features.filter((item) => item.featureType === "plot").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><button type="submit"><Plus size={16} />Save plot</button>
    </form>
    <form className="record-panel farm-builder-form" onSubmit={submit("irrigation-lines", lineForm)}>
      <h2>Irrigation line</h2><input required placeholder="Line code" value={lineForm.lineCode} onChange={(event) => setLineForm({ ...lineForm, lineCode: event.target.value })} /><input placeholder="Line name" value={lineForm.lineName} onChange={(event) => setLineForm({ ...lineForm, lineName: event.target.value })} /><textarea placeholder="Description" value={lineForm.description} onChange={(event) => setLineForm({ ...lineForm, description: event.target.value })} /><select value={lineForm.geoFeatureId} onChange={(event) => setLineForm({ ...lineForm, geoFeatureId: event.target.value })}><option value="">Link feature later</option>{features.filter((item) => item.featureType === "irrigation_line").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><button type="submit"><Plus size={16} />Save line</button>
    </form>
    <form className="record-panel farm-builder-form" onSubmit={submit("valves", { ...valveForm, estimatedTreeCount: numeric(valveForm.estimatedTreeCount) })}>
      <h2>Valve</h2><input required placeholder="Valve code" value={valveForm.valveCode} onChange={(event) => setValveForm({ ...valveForm, valveCode: event.target.value })} /><input placeholder="Valve name" value={valveForm.valveName} onChange={(event) => setValveForm({ ...valveForm, valveName: event.target.value })} /><select value={valveForm.irrigationLineId} onChange={(event) => setValveForm({ ...valveForm, irrigationLineId: event.target.value })}><option value="">Irrigation line</option>{dashboard.irrigationLines.map((item: IrrigationLine) => <option key={item.id} value={item.id}>{item.lineCode}</option>)}</select><select value={valveForm.plotId} onChange={(event) => setValveForm({ ...valveForm, plotId: event.target.value })}><option value="">Plot</option>{dashboard.plots.map((item: FarmPlot) => <option key={item.id} value={item.id}>{item.plotCode}</option>)}</select><input inputMode="numeric" placeholder="Estimated trees" value={valveForm.estimatedTreeCount} onChange={(event) => setValveForm({ ...valveForm, estimatedTreeCount: event.target.value })} /><select value={valveForm.geoFeatureId} onChange={(event) => setValveForm({ ...valveForm, geoFeatureId: event.target.value })}><option value="">Link feature later</option>{features.filter((item) => item.featureType === "valve").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><button type="submit"><Plus size={16} />Save valve</button>
    </form>
  </>;
}
