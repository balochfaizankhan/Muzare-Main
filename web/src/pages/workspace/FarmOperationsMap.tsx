import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarClock, Droplets, FileText, FlaskConical, Layers, MapPinned, Pencil, Plus, Save, SprayCan, Trash2, Upload, X } from "lucide-react";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { useAuth } from "../../auth/AuthProvider";
import { SubpageHeader } from "../../components/SubpageHeader";
import {
  createFarmOperationResource,
  deleteFarmOperationResource,
  fetchBootstrap,
  fetchFarmOperationLogs,
  fetchFarmOperationsDashboard,
  fetchFarmOperationsProducts,
  fetchFarmOperationResources,
  updateFarmOperationResource,
  type FarmFeatureType,
  type FarmMapFeature,
  type FarmPlot,
  type FarmValve,
  type IrrigationLine,
  type OperationActivityType,
  type OperationDueRule,
  type OperationLog,
  type WaterAsset,
} from "../../lib/api";
import { formatNumber } from "../../lib/format";
import { hasPermission } from "../../lib/permissions";

type Mode = "builder" | "live";
type Selected = { kind: "plot" | "line" | "valve" | "water_asset"; id: string } | null;
type WaterAssetMode = "pump" | "reservoir" | null;
type LayerKey = "plots" | "irrigation" | "valves" | "pumps" | "reservoirs" | "fertilizerStatus" | "pesticideStatus" | "irrigationStatus";
type ImportGeometryType = "Polygon" | "LineString" | "Point";
type ImportPreviewRow = {
  id: string;
  selected: boolean;
  sourceName: string;
  featureName: string;
  geometryType: ImportGeometryType;
  featureType: FarmFeatureType;
  geojson: Record<string, unknown>;
};

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
const emptyWaterAsset = { assetCode: "", assetName: "", status: "", notes: "" };
const emptyRule = {
  seasonId: null,
  plotId: "",
  activityType: "irrigation" as OperationActivityType,
  activityCategory: "",
  productId: "",
  intervalDays: "5",
  dueSoonDays: "1",
  active: true,
  notes: "",
};
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
type RuleForm = Omit<typeof emptyRule, "seasonId"> & { seasonId: string | null };
const statusColors: Record<string, string> = {
  ok: "#16a34a",
  due_soon: "#eab308",
  overdue: "#dc2626",
  completed_today: "#2563eb",
  none: "#9ca3af",
};
const activityOptions: OperationActivityType[] = ["irrigation", "fertilizer", "pesticide", "pruning", "thinning", "pollination", "harvesting", "maintenance", "other"];
const featureTypeOptions: FarmFeatureType[] = ["farm_boundary", "plot", "irrigation_line", "valve", "landmark", "other"];

function localChildren(element: Element | Document, name: string) {
  return Array.from(element.getElementsByTagName("*")).filter((item) => item.localName === name);
}

function firstLocalText(element: Element, name: string) {
  return localChildren(element, name)[0]?.textContent?.trim() ?? "";
}

function parseKmlCoordinates(text: string) {
  return text.trim().split(/\s+/).map((tuple) => {
    const [lng, lat] = tuple.split(",").map(Number);
    return Number.isFinite(lng) && Number.isFinite(lat) ? [lng, lat] : null;
  }).filter(Boolean) as number[][];
}

function closeRing(ring: number[][]) {
  if (ring.length < 3) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

function defaultFeatureType(geometryType: ImportGeometryType): FarmFeatureType {
  if (geometryType === "Polygon") return "plot";
  if (geometryType === "LineString") return "irrigation_line";
  return "valve";
}

function geometryFeatureTypes(geometryType: ImportGeometryType): FarmFeatureType[] {
  if (geometryType === "Polygon") return ["plot", "farm_boundary", "other"];
  if (geometryType === "LineString") return ["irrigation_line", "other"];
  return ["valve", "landmark", "other"];
}

function parseKmlToPreviewRows(kmlText: string) {
  const documentXml = new DOMParser().parseFromString(kmlText, "application/xml");
  if (documentXml.querySelector("parsererror")) throw new Error("The KML file could not be parsed.");
  const placemarks = localChildren(documentXml, "Placemark");
  const rows: ImportPreviewRow[] = [];
  placemarks.forEach((placemark, placemarkIndex) => {
    const name = firstLocalText(placemark, "name") || `Placemark ${placemarkIndex + 1}`;
    localChildren(placemark, "Polygon").forEach((polygon, index) => {
      const rings = localChildren(polygon, "LinearRing")
        .map((ring) => closeRing(parseKmlCoordinates(firstLocalText(ring, "coordinates"))))
        .filter((ring) => ring.length >= 4);
      if (!rings.length) return;
      const geometryType = "Polygon" as const;
      rows.push({
        id: `${placemarkIndex}:polygon:${index}`,
        selected: true,
        sourceName: name,
        featureName: index ? `${name} polygon ${index + 1}` : name,
        geometryType,
        featureType: defaultFeatureType(geometryType),
        geojson: { type: "Polygon", coordinates: rings },
      });
    });
    localChildren(placemark, "LineString").forEach((line, index) => {
      const coordinates = parseKmlCoordinates(firstLocalText(line, "coordinates"));
      if (coordinates.length < 2) return;
      const geometryType = "LineString" as const;
      rows.push({
        id: `${placemarkIndex}:line:${index}`,
        selected: true,
        sourceName: name,
        featureName: index ? `${name} path ${index + 1}` : name,
        geometryType,
        featureType: defaultFeatureType(geometryType),
        geojson: { type: "LineString", coordinates },
      });
    });
    localChildren(placemark, "Point").forEach((point, index) => {
      const coordinates = parseKmlCoordinates(firstLocalText(point, "coordinates"))[0];
      if (!coordinates) return;
      const geometryType = "Point" as const;
      rows.push({
        id: `${placemarkIndex}:point:${index}`,
        selected: true,
        sourceName: name,
        featureName: index ? `${name} marker ${index + 1}` : name,
        geometryType,
        featureType: defaultFeatureType(geometryType),
        geojson: { type: "Point", coordinates },
      });
    });
  });
  return rows;
}

async function readKmlOrKmz(file: File) {
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "kml") return file.text();
  if (extension !== "kmz") throw new Error("Upload a .kml or .kmz file.");
  const { default: JSZip } = await import("jszip");
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const kmlEntry = zip.file(/(^|\/)(doc\.kml|[^/]+\.kml)$/i)[0];
  if (!kmlEntry) throw new Error("The KMZ file does not contain a KML document.");
  return kmlEntry.async("text");
}

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
      linkedIrrigationLineId: feature.linkedIrrigationLineId,
      linkedValveId: feature.linkedValveId,
      status,
      fillColor: feature.featureType === "plot" ? statusColors[status] : "#2e7d32",
    },
  };
}

function buildWaterAssetFeatures(dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>) {
  const featuresById = new Map(dashboard.features.map((feature) => [feature.id, feature]));
  return dashboard.waterAssets.flatMap((asset) => {
    const feature = featuresById.get(asset.linkedFeatureId ?? "");
    if (!feature) return [];
    const geojson = feature.geojson.type === "Feature"
      ? feature.geojson
      : { type: "Feature", geometry: feature.geojson, properties: {} };
    return [{
      ...geojson,
      id: `water:${asset.id}`,
      properties: {
        ...((geojson.properties as Record<string, unknown>) ?? {}),
        featureId: feature.id,
        featureType: asset.assetType === "pump" ? "water_pump" : "water_reservoir",
        waterAssetId: asset.id,
      },
    }];
  });
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
  assetMode,
  onMapPoint,
}: {
  dashboard: ReturnType<typeof useDashboardData>["dashboard"];
  activeStatus: OperationActivityType;
  layers: Record<LayerKey, boolean>;
  onSelect: (selection: Selected) => void;
  assetMode?: WaterAssetMode;
  onMapPoint?: (point: { lng: number; lat: number }) => void;
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
    mapRef.current.on("click", (event) => {
      if (assetMode && onMapPoint) onMapPoint({ lng: event.lngLat.lng, lat: event.lngLat.lat });
    });
    mapRef.current.on("click", "plot-fill", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.linkedPlotId as string | undefined;
      if (id) onSelect({ kind: "plot", id });
    });
    mapRef.current.on("click", "irrigation-lines", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.linkedIrrigationLineId as string | undefined;
      if (id) onSelect({ kind: "line", id });
    });
    mapRef.current.on("click", "valve-points", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.linkedValveId as string | undefined;
      if (id) onSelect({ kind: "valve", id });
    });
    mapRef.current.on("click", "water-pumps", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.waterAssetId as string | undefined;
      if (id) onSelect({ kind: "water_asset", id });
    });
    mapRef.current.on("click", "water-reservoirs", (event) => {
      if (assetMode) return;
      const id = event.features?.[0]?.properties?.waterAssetId as string | undefined;
      if (id) onSelect({ kind: "water_asset", id });
    });
    return () => {
      mapRef.current?.remove();
      mapRef.current = null;
    };
  }, [assetMode, dashboard?.farmMap, dashboard?.features, onMapPoint, onSelect]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !dashboard) return;
    const render = () => {
      const allFeatures = [
        ...dashboard.features.map((feature) => normalizeFeature(feature, statusByPlot, activeStatus)),
        ...buildWaterAssetFeatures(dashboard),
      ];
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
        map.addLayer({ id: "water-pumps", type: "circle", source: "farm-features", filter: ["==", ["get", "featureType"], "water_pump"], paint: { "circle-radius": 8, "circle-color": "#f97316", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
        map.addLayer({ id: "water-reservoirs", type: "circle", source: "farm-features", filter: ["==", ["get", "featureType"], "water_reservoir"], paint: { "circle-radius": 9, "circle-color": "#0891b2", "circle-stroke-width": 2, "circle-stroke-color": "#ffffff" } });
      }
      map.setLayoutProperty("plot-fill", "visibility", layers.plots ? "visible" : "none");
      map.setLayoutProperty("plot-line", "visibility", layers.plots ? "visible" : "none");
      map.setLayoutProperty("irrigation-lines", "visibility", layers.irrigation ? "visible" : "none");
      map.setLayoutProperty("valve-points", "visibility", layers.valves ? "visible" : "none");
      map.setLayoutProperty("water-pumps", "visibility", layers.pumps ? "visible" : "none");
      map.setLayoutProperty("water-reservoirs", "visibility", layers.reservoirs ? "visible" : "none");
    };
    if (map.loaded()) render();
    else map.once("load", render);
  }, [activeStatus, dashboard, layers.irrigation, layers.plots, layers.pumps, layers.reservoirs, layers.valves, statusByPlot]);

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
  mode,
  builderHref,
  onClose,
  onQuickLog,
  onEditPlot,
  onEditLine,
  onEditValve,
  onEditWaterAsset,
  onDeactivatePlot,
  onDeactivateLine,
  onDeactivateValve,
  onDeleteWaterAsset,
}: {
  selected: Selected;
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>;
  logs: OperationLog[];
  mode: Mode;
  builderHref: string;
  onClose: () => void;
  onQuickLog: (activity: OperationActivityType, selection: Selected) => void;
  onEditPlot: (plot: FarmPlot) => void;
  onEditLine: (line: IrrigationLine) => void;
  onEditValve: (valve: FarmValve) => void;
  onEditWaterAsset: (asset: WaterAsset) => void;
  onDeactivatePlot: (plot: FarmPlot) => void;
  onDeactivateLine: (line: IrrigationLine) => void;
  onDeactivateValve: (valve: FarmValve) => void;
  onDeleteWaterAsset: (asset: WaterAsset) => void;
}) {
  if (!selected) return null;
  const plot = selected.kind === "plot" ? dashboard.plots.find((item) => item.id === selected.id) : null;
  const irrigationLine = selected.kind === "line" ? dashboard.irrigationLines.find((item) => item.id === selected.id) : null;
  const valve = selected.kind === "valve" ? dashboard.valves.find((item) => item.id === selected.id) : null;
  const waterAsset = selected.kind === "water_asset" ? dashboard.waterAssets.find((item) => item.id === selected.id) : null;
  const linkedPlot = plot ?? dashboard.plots.find((item) => item.id === valve?.plotId);
  const linkedValves = linkedPlot ? dashboard.valves.filter((item) => item.plotId === linkedPlot.id) : [];
  const line = irrigationLine ?? dashboard.irrigationLines.find((item) => item.id === valve?.irrigationLineId);
  const statuses = linkedPlot ? dashboard.plotStatusSummary.find((item) => item.plotId === linkedPlot.id)?.statuses : undefined;
  const scopedLogs = logs.filter((item) => selected.kind === "plot" ? item.plotId === selected.id : selected.kind === "line" ? item.irrigationLineId === selected.id : item.valveId === selected.id).slice(0, 12);
  const managementHint = mode === "live" ? <Link className="secondary-button farm-drawer-link" to={builderHref}>Open builder to edit</Link> : null;
  return <aside className="farm-map-drawer">
    <button className="farm-map-drawer__close" type="button" onClick={onClose}><X size={16} /></button>
    {waterAsset && <>
      <h2>{waterAsset.assetType === "pump" ? "Pump / Borehole" : "Reservoir"}</h2>
      <dl className="farm-map-facts">
        <div><dt>Asset Code</dt><dd>{waterAsset.assetCode}</dd></div>
        <div><dt>Asset Name</dt><dd>{waterAsset.assetName}</dd></div>
        <div><dt>Status</dt><dd>{waterAsset.status || "-"}</dd></div>
        <div><dt>Notes</dt><dd>{waterAsset.notes || "-"}</dd></div>
      </dl>
      <div className="farm-drawer-actions">
        <button type="button" onClick={() => onEditWaterAsset(waterAsset)}><Pencil size={15} />Edit asset</button>
        <button className="danger-button" type="button" onClick={() => onDeleteWaterAsset(waterAsset)}><Trash2 size={15} />Delete asset</button>
      </div>
      {managementHint}
    </>}
    {plot && <><h2>{plot.plotCode} {plot.plotName ?? ""}</h2><p>{plot.variety ?? "Variety not recorded"} | {plot.treeCount ?? 0} trees</p><StatusBadges statuses={statuses} /></>}
    {irrigationLine && <><h2>{irrigationLine.lineCode} {irrigationLine.lineName ?? ""}</h2><p>{irrigationLine.description || "Irrigation line"}</p></>}
    {valve && <><h2>{valve.valveCode} {valve.valveName ?? ""}</h2><p>{line?.lineName ?? line?.lineCode ?? "No line"} | {linkedPlot?.plotName ?? linkedPlot?.plotCode ?? "No plot"}</p><StatusBadges statuses={statuses} /></>}
    {!waterAsset && <div className="farm-quick-actions">
      <button type="button" onClick={() => onQuickLog("irrigation", selected)}><Droplets size={17} />Log irrigation</button>
      <button type="button" onClick={() => onQuickLog("fertilizer", selected)}><FlaskConical size={17} />Log fertilizer</button>
      <button type="button" onClick={() => onQuickLog("pesticide", selected)}><SprayCan size={17} />Log spray</button>
      <button type="button" onClick={() => onQuickLog("maintenance", selected)}><FileText size={17} />Report issue</button>
    </div>}
    {plot && <><div className="farm-drawer-actions"><button type="button" onClick={() => onEditPlot(plot)}><Pencil size={15} />Edit plot</button><button className="danger-button" type="button" onClick={() => onDeactivatePlot(plot)}><Trash2 size={15} />Delete / deactivate</button></div>{managementHint}</>}
    {irrigationLine && <><div className="farm-drawer-actions"><button type="button" onClick={() => onEditLine(irrigationLine)}><Pencil size={15} />Edit line</button><button className="danger-button" type="button" onClick={() => onDeactivateLine(irrigationLine)}><Trash2 size={15} />Delete / deactivate</button></div>{managementHint}</>}
    {valve && <><div className="farm-drawer-actions"><button type="button" onClick={() => onEditValve(valve)}><Pencil size={15} />Edit valve</button><button className="danger-button" type="button" onClick={() => onDeactivateValve(valve)}><Trash2 size={15} />Delete / deactivate</button></div>{managementHint}</>}
    {!waterAsset && <dl className="farm-map-facts">
      <div><dt>Linked valves</dt><dd>{linkedValves.map((item) => item.valveCode).join(", ") || "-"}</dd></div>
      <div><dt>Linked lines</dt><dd>{[...new Set(linkedValves.map((item) => dashboard.irrigationLines.find((lineItem) => lineItem.id === item.irrigationLineId)?.lineCode).filter(Boolean))].join(", ") || line?.lineCode || "-"}</dd></div>
      <div><dt>Pending work</dt><dd>{dashboard.dueWorkList.filter((item) => item.plotId === linkedPlot?.id).map((item) => `${item.activityType} ${item.status}`).join(", ") || "-"}</dd></div>
    </dl>}
    {!waterAsset && <><h3>Operation history</h3>
      <div className="farm-log-list">{scopedLogs.map((log) => <article key={log.id}><strong>{log.activityType}</strong><span>{log.operationDate} {log.totalQty ? `| ${log.totalQty} ${log.unit ?? ""}` : ""}</span><small>{log.performedBy || log.remarks || "-"}</small></article>)}</div></>}
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
  const canManage = Boolean(user && hasPermission(user, "MANAGE_RECORDS", workspaceId));
  const dashboardQuery = useDashboardData(workspaceId, farmId, activeSeasonId);
  const products = useQuery({ queryKey: ["farm-products", workspaceId, farmId], queryFn: () => fetchFarmOperationsProducts(token!, workspaceId, farmId), enabled: Boolean(token && workspaceId && farmId) });
  const logsQuery = useQuery({ queryKey: ["farm-operation-logs", workspaceId, farmId, activeSeasonId], queryFn: () => fetchFarmOperationLogs(token!, workspaceId, { farmId, seasonId: activeSeasonId }), enabled: Boolean(token && workspaceId && farmId) });
  const plotsQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "plots"], queryFn: () => fetchFarmOperationResources<FarmPlot>(token!, workspaceId, farmId, "plots"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const linesQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "irrigation-lines"], queryFn: () => fetchFarmOperationResources<IrrigationLine>(token!, workspaceId, farmId, "irrigation-lines"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const valvesQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "valves"], queryFn: () => fetchFarmOperationResources<FarmValve>(token!, workspaceId, farmId, "valves"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const featuresQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "features"], queryFn: () => fetchFarmOperationResources<FarmMapFeature>(token!, workspaceId, farmId, "features"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const waterAssetsQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "water-assets"], queryFn: () => fetchFarmOperationResources<WaterAsset>(token!, workspaceId, farmId, "water-assets"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const rulesQuery = useQuery({ queryKey: ["farm-operation-records", workspaceId, farmId, "operation-due-rules"], queryFn: () => fetchFarmOperationResources<OperationDueRule>(token!, workspaceId, farmId, "operation-due-rules"), enabled: Boolean(token && workspaceId && farmId && canManage) });
  const [selected, setSelected] = useState<Selected>(null);
  const [activeStatus, setActiveStatus] = useState<OperationActivityType>("irrigation");
  const [layers, setLayers] = useState<Record<LayerKey, boolean>>({ plots: true, irrigation: true, valves: true, pumps: true, reservoirs: true, fertilizerStatus: true, pesticideStatus: true, irrigationStatus: true });
  const [featureForm, setFeatureForm] = useState<FeatureForm>(emptyFeature);
  const [plotForm, setPlotForm] = useState<PlotForm>(emptyPlot);
  const [lineForm, setLineForm] = useState<LineForm>(emptyLine);
  const [valveForm, setValveForm] = useState<ValveForm>(emptyValve);
  const [assetMode, setAssetMode] = useState<WaterAssetMode>(null);
  const [assetPoint, setAssetPoint] = useState<{ lng: number; lat: number } | null>(null);
  const [assetForm, setAssetForm] = useState(emptyWaterAsset);
  const [mapForm, setMapForm] = useState({ mapName: "Farm satellite operations map", centerLat: "24.7136", centerLng: "46.6753", defaultZoom: "16", notes: "" });
  const [logForm, setLogForm] = useState(emptyLog);
  const [ruleForm, setRuleForm] = useState<RuleForm>(emptyRule);
  const [editingIds, setEditingIds] = useState<{ feature: string | null; plot: string | null; line: string | null; valve: string | null; waterAsset: string | null; log: string | null; rule: string | null }>({ feature: null, plot: null, line: null, valve: null, waterAsset: null, log: null, rule: null });
  const [showInactive, setShowInactive] = useState(false);
  const [showLog, setShowLog] = useState(false);
  const [importRows, setImportRows] = useState<ImportPreviewRow[]>([]);
  const [importFilename, setImportFilename] = useState("");
  const [importError, setImportError] = useState("");
  const dashboard = dashboardQuery.dashboard;
  useEffect(() => {
    if (activeSeasonId) {
      setLogForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setFeatureForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setPlotForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setLineForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setValveForm((current) => ({ ...current, seasonId: activeSeasonId }));
      setRuleForm((current) => ({ ...current, seasonId: activeSeasonId }));
    }
  }, [activeSeasonId]);
  useEffect(() => {
    if (dashboard?.farmMap) setMapForm({ mapName: dashboard.farmMap.mapName, centerLat: dashboard.farmMap.centerLat, centerLng: dashboard.farmMap.centerLng, defaultZoom: dashboard.farmMap.defaultZoom, notes: dashboard.farmMap.notes ?? "" });
  }, [dashboard?.farmMap]);
  const resetFeatureForm = () => {
    setFeatureForm({ ...emptyFeature, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, feature: null }));
  };
  const resetPlotForm = () => {
    setPlotForm({ ...emptyPlot, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, plot: null }));
  };
  const resetLineForm = () => {
    setLineForm({ ...emptyLine, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, line: null }));
  };
  const resetValveForm = () => {
    setValveForm({ ...emptyValve, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, valve: null }));
  };
  const resetWaterAssetForm = () => {
    setAssetMode(null);
    setAssetPoint(null);
    setAssetForm(emptyWaterAsset);
    setEditingIds((current) => ({ ...current, waterAsset: null }));
  };
  const resetLogForm = () => {
    setLogForm({ ...emptyLog, seasonId: activeSeasonId ?? "" });
    setEditingIds((current) => ({ ...current, log: null }));
  };
  const resetRuleForm = () => {
    setRuleForm({ ...emptyRule, seasonId: activeSeasonId });
    setEditingIds((current) => ({ ...current, rule: null }));
  };
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["farm-operations-dashboard", workspaceId, farmId] }),
      queryClient.invalidateQueries({ queryKey: ["farm-operation-logs", workspaceId, farmId] }),
      queryClient.invalidateQueries({ queryKey: ["farm-operation-records", workspaceId, farmId] }),
    ]);
  };
  const saveResource = useMutation({
    mutationFn: ({ resource, input, id }: { resource: string; input: unknown; id?: string }) => id
      ? updateFarmOperationResource(token!, workspaceId, farmId, resource, id, input)
      : createFarmOperationResource(token!, workspaceId, farmId, resource, input),
    onSuccess: refresh,
  });
  const deleteResource = useMutation({
    mutationFn: ({ resource, id }: { resource: string; id: string }) => deleteFarmOperationResource(token!, workspaceId, farmId, resource, id),
    onSuccess: refresh,
  });
  const deactivateResource = async (resource: string, id: string, input: Record<string, unknown>) => {
    await updateFarmOperationResource(token!, workspaceId, farmId, resource, id, { ...input, active: false });
    await refresh();
  };
  const quickLog = (activity: OperationActivityType, selection: Selected) => {
    const valve = selection?.kind === "valve" ? dashboard?.valves.find((item) => item.id === selection.id) : null;
    const line = selection?.kind === "line" ? dashboard?.irrigationLines.find((item) => item.id === selection.id) : dashboard?.irrigationLines.find((item) => item.id === valve?.irrigationLineId);
    const plot = selection?.kind === "plot" ? dashboard?.plots.find((item) => item.id === selection.id) : dashboard?.plots.find((item) => item.id === valve?.plotId);
    setLogForm({ ...emptyLog, seasonId: activeSeasonId ?? "", activityType: activity, plotId: plot?.id ?? "", valveId: valve?.id ?? "", irrigationLineId: valve?.irrigationLineId ?? "", treeCountCovered: String(plot?.treeCount ?? valve?.estimatedTreeCount ?? "") });
    if (selection?.kind === "line" && line) setLogForm((current) => ({ ...current, irrigationLineId: line.id }));
    setEditingIds((current) => ({ ...current, log: null }));
    setShowLog(true);
  };
  const submitLog = (input: typeof emptyLog) => saveResource.mutate({
    resource: "operation-logs",
    id: editingIds.log ?? undefined,
    input: {
      ...input,
      durationMinutes: input.durationMinutes || null,
      qtyPerTree: input.qtyPerTree || null,
      totalQty: input.totalQty || null,
      treeCountCovered: input.treeCountCovered || null,
    },
  }, { onSuccess: () => {
    resetLogForm();
    setShowLog(false);
  } });
  const saveFeature = (event: FormEvent) => {
    event.preventDefault();
    let geojson: Record<string, unknown>;
    try {
      geojson = JSON.parse(featureForm.geojsonText) as Record<string, unknown>;
    } catch {
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: "GeoJSON is not valid JSON." }));
      return;
    }
    saveResource.mutate({ resource: "features", id: editingIds.feature ?? undefined, input: { ...featureForm, geojson, styleJson: null, geojsonText: undefined } }, { onSuccess: resetFeatureForm });
  };
  const saveMap = (event: FormEvent) => {
    event.preventDefault();
    const input = { ...mapForm, seasonId: activeSeasonId, baseMapProvider: "maplibre_satellite" };
    saveResource.mutate({ resource: "maps", id: dashboard?.farmMap?.id, input });
  };
  const beginWaterAsset = (nextMode: Exclude<WaterAssetMode, null>) => {
    setAssetMode(nextMode);
    setAssetPoint(null);
    setAssetForm(emptyWaterAsset);
    setEditingIds((current) => ({ ...current, waterAsset: null }));
    window.dispatchEvent(new CustomEvent("muzare-toast", { detail: `Click the map location for the ${nextMode === "pump" ? "pump / borehole" : "reservoir"}.` }));
  };
  const saveWaterAsset = async (event: FormEvent) => {
    event.preventDefault();
    if (!assetMode) return;
    try {
      let linkedFeatureId = waterAssetsQuery.data?.records.find((item) => item.id === editingIds.waterAsset)?.linkedFeatureId ?? null;
      if (!linkedFeatureId) {
        if (!assetPoint) return;
        const featureResult = await saveResource.mutateAsync({
          resource: "features",
          input: {
            seasonId: activeSeasonId,
            featureType: "landmark",
            featureCode: assetForm.assetCode,
            featureName: assetForm.assetName,
            geojson: { type: "Point", coordinates: [assetPoint.lng, assetPoint.lat] },
            linkedPlotId: "",
            linkedIrrigationLineId: "",
            linkedValveId: "",
            styleJson: { waterAssetType: assetMode },
            displayOrder: 0,
            active: true,
          },
        }) as { record: FarmMapFeature };
        linkedFeatureId = featureResult.record.id;
      }
      await saveResource.mutateAsync({
        resource: "water-assets",
        id: editingIds.waterAsset ?? undefined,
        input: {
          seasonId: activeSeasonId,
          assetType: assetMode,
          assetCode: assetForm.assetCode,
          assetName: assetForm.assetName,
          linkedFeatureId,
          status: assetForm.status,
          notes: assetForm.notes,
          active: true,
        },
      });
      resetWaterAssetForm();
      await refresh();
    } catch (error) {
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: error instanceof Error ? error.message : "Unable to save water asset." }));
    }
  };
  const saveRule = (event: FormEvent) => {
    event.preventDefault();
    saveResource.mutate({
      resource: "operation-due-rules",
      id: editingIds.rule ?? undefined,
      input: {
        ...ruleForm,
        intervalDays: Number(ruleForm.intervalDays),
        dueSoonDays: Number(ruleForm.dueSoonDays),
      },
    }, { onSuccess: resetRuleForm });
  };
  const uploadKml = async (file: File | null) => {
    if (!file) return;
    setImportError("");
    setImportFilename(file.name);
    try {
      const rows = parseKmlToPreviewRows(await readKmlOrKmz(file));
      setImportRows(rows);
      if (!rows.length) setImportError("No Polygon, LineString, or Point placemarks were found in this file.");
    } catch (error) {
      setImportRows([]);
      setImportError(error instanceof Error ? error.message : "Unable to import this farm layout.");
    }
  };
  const updateImportRow = (id: string, patch: Partial<ImportPreviewRow>) => {
    setImportRows((rows) => rows.map((row) => row.id === id ? { ...row, ...patch } : row));
  };
  const saveImportRows = async () => {
    const selectedRows = importRows.filter((row) => row.selected);
    if (!selectedRows.length) {
      setImportError("Select at least one feature to import.");
      return;
    }
    setImportError("");
    try {
      for (const [index, row] of selectedRows.entries()) {
        await saveResource.mutateAsync({
          resource: "features",
          input: {
            seasonId: activeSeasonId,
            featureType: row.featureType,
            featureCode: row.featureName.trim().slice(0, 80) || `${row.geometryType}-${index + 1}`,
            featureName: row.featureName.trim() || row.sourceName,
            geojson: row.geojson,
            linkedPlotId: "",
            linkedIrrigationLineId: "",
            linkedValveId: "",
            styleJson: null,
            displayOrder: index,
            active: true,
          },
        });
      }
      setImportRows([]);
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: `${selectedRows.length} farm map features imported.` }));
      await refresh();
    } catch (error) {
      setImportError(error instanceof Error ? error.message : "Unable to save imported features.");
    }
  };
  const startEditFeature = (feature: FarmMapFeature) => {
    setFeatureForm({
      seasonId: feature.seasonId,
      featureType: feature.featureType,
      featureCode: feature.featureCode ?? "",
      featureName: feature.featureName,
      geojsonText: JSON.stringify(feature.geojson, null, 2),
      linkedPlotId: feature.linkedPlotId ?? "",
      linkedIrrigationLineId: feature.linkedIrrigationLineId ?? "",
      linkedValveId: feature.linkedValveId ?? "",
      displayOrder: feature.displayOrder,
      active: feature.active,
    });
    setEditingIds((current) => ({ ...current, feature: feature.id }));
  };
  const startEditPlot = (plot: FarmPlot) => {
    setPlotForm({
      seasonId: plot.seasonId,
      plotCode: plot.plotCode,
      plotName: plot.plotName ?? "",
      variety: plot.variety ?? "",
      treeCount: plot.treeCount === null ? "" : String(plot.treeCount),
      area: plot.area ?? "",
      notes: plot.notes ?? "",
      geoFeatureId: plot.geoFeatureId ?? "",
      active: plot.active,
    });
    setEditingIds((current) => ({ ...current, plot: plot.id }));
  };
  const startEditLine = (line: IrrigationLine) => {
    setLineForm({
      seasonId: line.seasonId,
      lineCode: line.lineCode,
      lineName: line.lineName ?? "",
      description: line.description ?? "",
      geoFeatureId: line.geoFeatureId ?? "",
      active: line.active,
    });
    setEditingIds((current) => ({ ...current, line: line.id }));
  };
  const startEditValve = (valve: FarmValve) => {
    setValveForm({
      seasonId: valve.seasonId,
      valveCode: valve.valveCode,
      valveName: valve.valveName ?? "",
      irrigationLineId: valve.irrigationLineId ?? "",
      plotId: valve.plotId ?? "",
      estimatedTreeCount: valve.estimatedTreeCount === null ? "" : String(valve.estimatedTreeCount),
      notes: valve.notes ?? "",
      geoFeatureId: valve.geoFeatureId ?? "",
      active: valve.active,
    });
    setEditingIds((current) => ({ ...current, valve: valve.id }));
  };
  const startEditWaterAsset = (asset: WaterAsset) => {
    setAssetMode(asset.assetType);
    setAssetForm({ assetCode: asset.assetCode, assetName: asset.assetName, status: asset.status ?? "", notes: asset.notes ?? "" });
    setEditingIds((current) => ({ ...current, waterAsset: asset.id }));
  };
  const startEditRule = (rule: OperationDueRule) => {
    setRuleForm({
      seasonId: rule.seasonId,
      plotId: rule.plotId ?? "",
      activityType: rule.activityType,
      activityCategory: rule.activityCategory ?? "",
      productId: rule.productId ?? "",
      intervalDays: String(rule.intervalDays),
      dueSoonDays: String(rule.dueSoonDays),
      active: rule.active,
      notes: rule.notes ?? "",
    });
    setEditingIds((current) => ({ ...current, rule: rule.id }));
  };
  const startEditLog = (log: OperationLog) => {
    setLogForm({
      seasonId: log.seasonId,
      plotId: log.plotId ?? "",
      irrigationLineId: log.irrigationLineId ?? "",
      valveId: log.valveId ?? "",
      activityType: log.activityType,
      activityCategory: log.activityCategory ?? "",
      productId: log.productId ?? "",
      productNameText: log.productNameText ?? "",
      operationDate: log.operationDate,
      startTime: log.startTime ?? "",
      endTime: log.endTime ?? "",
      durationMinutes: log.durationMinutes === null ? "" : String(log.durationMinutes),
      qtyPerTree: log.qtyPerTree ?? "",
      totalQty: log.totalQty ?? "",
      unit: log.unit ?? "",
      treeCountCovered: log.treeCountCovered === null ? "" : String(log.treeCountCovered),
      performedBy: log.performedBy ?? "",
      labourTeamId: "",
      remarks: log.remarks ?? "",
    });
    setEditingIds((current) => ({ ...current, log: log.id }));
    setShowLog(true);
  };
  const requestDelete = async (resource: string, id: string, label: string, inputForDeactivate?: Record<string, unknown>) => {
    if (!window.confirm(`Delete ${label}? This cannot be undone.`)) return;
    try {
      await deleteResource.mutateAsync({ resource, id });
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: `${label} deleted.` }));
    } catch (error) {
      if (error instanceof Error && "status" in error && (error as { status?: number }).status === 409 && inputForDeactivate) {
        if (window.confirm(`${label} has linked history or map records and cannot be deleted. Deactivate it instead?`)) {
          await deactivateResource(resource, id, inputForDeactivate);
          window.dispatchEvent(new CustomEvent("muzare-toast", { detail: `${label} deactivated.` }));
        }
        return;
      }
      window.dispatchEvent(new CustomEvent("muzare-toast", { detail: error instanceof Error ? error.message : `Unable to delete ${label}.` }));
    }
  };
  const logs = logsQuery.data?.records ?? [];
  const managedPlots = (plotsQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedLines = (linesQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedValves = (valvesQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedFeatures = (featuresQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedWaterAssets = (waterAssetsQuery.data?.records ?? []).filter((item) => showInactive || item.active);
  const managedRules = (rulesQuery.data?.records ?? []).filter((item) => showInactive || item.active);
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
          <article><span>Total pumps</span><strong>{dashboard.waterAssets.filter((item) => item.assetType === "pump").length}</strong></article>
          <article><span>Total reservoirs</span><strong>{dashboard.waterAssets.filter((item) => item.assetType === "reservoir").length}</strong></article>
        </section>
        <section className="farm-map-workspace">
          <div className="farm-map-panel">
            <div className="farm-map-toolbar">
              <div className="farm-map-layer-toggles">
                {(["plots", "irrigation", "valves", "pumps", "reservoirs"] as LayerKey[]).map((key) => <button className={layers[key] ? "is-active" : ""} type="button" key={key} onClick={() => setLayers({ ...layers, [key]: !layers[key] })}><Layers size={15} />{key}</button>)}
              </div>
              <div className="farm-map-layer-toggles">
                {(["irrigation", "fertilizer", "pesticide"] as OperationActivityType[]).map((key) => <button className={activeStatus === key ? "is-active" : ""} type="button" key={key} onClick={() => setActiveStatus(key)}>{key}</button>)}
              </div>
            </div>
            <MapCanvas dashboard={dashboard} activeStatus={activeStatus} layers={layers} onSelect={setSelected} assetMode={assetMode} onMapPoint={setAssetPoint} />
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
          <label className="farm-show-inactive">
            <input checked={showInactive} type="checkbox" onChange={(event) => setShowInactive(event.target.checked)} />
            Show inactive
          </label>
          <form className="record-panel farm-builder-form" onSubmit={saveMap}>
            <h2>Map setup</h2>
            <input placeholder="Map name" value={mapForm.mapName} onChange={(event) => setMapForm({ ...mapForm, mapName: event.target.value })} />
            <input inputMode="decimal" placeholder="Center latitude" value={mapForm.centerLat} onChange={(event) => setMapForm({ ...mapForm, centerLat: event.target.value })} />
            <input inputMode="decimal" placeholder="Center longitude" value={mapForm.centerLng} onChange={(event) => setMapForm({ ...mapForm, centerLng: event.target.value })} />
            <input inputMode="decimal" placeholder="Default zoom" value={mapForm.defaultZoom} onChange={(event) => setMapForm({ ...mapForm, defaultZoom: event.target.value })} />
            <textarea placeholder="Notes" value={mapForm.notes} onChange={(event) => setMapForm({ ...mapForm, notes: event.target.value })} />
            <button type="submit"><Save size={16} />Save map</button>
          </form>
          <section className="record-panel farm-water-builder">
            <header>
              <h2>Water infrastructure</h2>
              <div>
                <button type="button" className={assetMode === "pump" ? "is-active" : ""} onClick={() => beginWaterAsset("pump")}><Plus size={16} />Add Pump / Borehole</button>
                <button type="button" className={assetMode === "reservoir" ? "is-active" : ""} onClick={() => beginWaterAsset("reservoir")}><Plus size={16} />Add Reservoir</button>
              </div>
            </header>
            {assetMode && <form className="farm-builder-form" onSubmit={saveWaterAsset}>
              <p>{assetPoint ? `Location selected: ${assetPoint.lat.toFixed(6)}, ${assetPoint.lng.toFixed(6)}` : "Click the map location, then enter code and name."}</p>
              <input required placeholder="Asset code" value={assetForm.assetCode} onChange={(event) => setAssetForm({ ...assetForm, assetCode: event.target.value })} />
              <input required placeholder="Asset name" value={assetForm.assetName} onChange={(event) => setAssetForm({ ...assetForm, assetName: event.target.value })} />
              <input placeholder="Status" value={assetForm.status} onChange={(event) => setAssetForm({ ...assetForm, status: event.target.value })} />
              <textarea placeholder="Notes" value={assetForm.notes} onChange={(event) => setAssetForm({ ...assetForm, notes: event.target.value })} />
              <div className="farm-water-builder__actions">
                <button type="submit" disabled={(!editingIds.waterAsset && !assetPoint) || saveResource.isPending}><Save size={16} />{editingIds.waterAsset ? "Update" : "Save"} {assetMode === "pump" ? "pump / borehole" : "reservoir"}</button>
                <button className="secondary-button" type="button" onClick={resetWaterAssetForm}>Cancel</button>
              </div>
            </form>}
            <RecordManagerList
              title="Existing water assets"
              items={managedWaterAssets}
              getLabel={(item) => `${item.assetCode} ${item.assetName}`}
              getMeta={(item) => `${item.assetType} • ${item.status || "No status"}${item.active ? "" : " • inactive"}`}
              onEdit={startEditWaterAsset}
              onDelete={(item) => void requestDelete("water-assets", item.id, item.assetName, {
                seasonId: item.seasonId,
                assetType: item.assetType,
                assetCode: item.assetCode,
                assetName: item.assetName,
                linkedFeatureId: item.linkedFeatureId ?? "",
                status: item.status ?? "",
                notes: item.notes ?? "",
                active: item.active,
              })}
            />
          </section>
          <section className="record-panel farm-kml-import">
            <header>
              <div>
                <h2><Upload size={17} />KML/KMZ farm layout import</h2>
                <p>Import Google Earth polygons as plots, paths as irrigation lines, and placemarks as valves.</p>
              </div>
              <label className="farm-file-picker">
                <Upload size={16} />
                Choose KML/KMZ
                <input accept=".kml,.kmz,application/vnd.google-earth.kml+xml,application/vnd.google-earth.kmz" type="file" onChange={(event) => void uploadKml(event.target.files?.[0] ?? null)} />
              </label>
            </header>
            {importFilename && <p className="farm-import-meta">{importFilename} | {importRows.length} detected features</p>}
            {importError && <p className="error">{importError}</p>}
            {importRows.length > 0 && <>
              <div className="farm-import-table-wrap">
                <table className="farm-import-table">
                  <thead><tr><th>Import</th><th>Name</th><th>Geometry</th><th>Map as</th><th>Coordinates</th></tr></thead>
                  <tbody>
                    {importRows.map((row) => {
                      const coordinates = row.geojson.coordinates as unknown[];
                      return <tr key={row.id}>
                        <td><input aria-label={`Import ${row.featureName}`} type="checkbox" checked={row.selected} onChange={(event) => updateImportRow(row.id, { selected: event.target.checked })} /></td>
                        <td><input value={row.featureName} onChange={(event) => updateImportRow(row.id, { featureName: event.target.value })} /></td>
                        <td>{row.geometryType}</td>
                        <td><select value={row.featureType} onChange={(event) => updateImportRow(row.id, { featureType: event.target.value as FarmFeatureType })}>{geometryFeatureTypes(row.geometryType).map((type) => <option key={type}>{type}</option>)}</select></td>
                        <td>{Array.isArray(coordinates[0]) ? coordinates.length : 1}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              <footer>
                <button type="button" disabled={saveResource.isPending} onClick={() => void saveImportRows()}><Save size={16} />Save selected features</button>
                <button className="secondary-button" type="button" onClick={() => setImportRows([])}>Clear preview</button>
              </footer>
            </>}
          </section>
          <form className="record-panel farm-builder-form" onSubmit={saveFeature}>
            <h2>{editingIds.feature ? "Edit GeoJSON feature" : "GeoJSON feature"}</h2>
            <select value={featureForm.featureType} onChange={(event) => setFeatureForm({ ...featureForm, featureType: event.target.value })}>{featureTypeOptions.map((item) => <option key={item}>{item}</option>)}</select>
            <input placeholder="Feature code" value={featureForm.featureCode} onChange={(event) => setFeatureForm({ ...featureForm, featureCode: event.target.value })} />
            <input required placeholder="Feature name" value={featureForm.featureName} onChange={(event) => setFeatureForm({ ...featureForm, featureName: event.target.value })} />
            <textarea required placeholder='Paste GeoJSON geometry or Feature' value={featureForm.geojsonText} onChange={(event) => setFeatureForm({ ...featureForm, geojsonText: event.target.value })} />
            <select value={featureForm.linkedPlotId} onChange={(event) => setFeatureForm({ ...featureForm, linkedPlotId: event.target.value })}><option value="">Link plot later</option>{dashboard.plots.map((plot) => <option key={plot.id} value={plot.id}>{plot.plotCode}</option>)}</select>
            <select value={featureForm.linkedIrrigationLineId} onChange={(event) => setFeatureForm({ ...featureForm, linkedIrrigationLineId: event.target.value })}><option value="">Link line later</option>{dashboard.irrigationLines.map((line) => <option key={line.id} value={line.id}>{line.lineCode}</option>)}</select>
            <select value={featureForm.linkedValveId} onChange={(event) => setFeatureForm({ ...featureForm, linkedValveId: event.target.value })}><option value="">Link valve later</option>{dashboard.valves.map((valve) => <option key={valve.id} value={valve.id}>{valve.valveCode}</option>)}</select>
            <div className="farm-form-actions">
              <button type="submit"><Plus size={16} />{editingIds.feature ? "Update feature" : "Import feature"}</button>
              {editingIds.feature && <button className="secondary-button" type="button" onClick={resetFeatureForm}>Cancel</button>}
            </div>
            <RecordManagerList
              title="Existing map features"
              items={managedFeatures}
              getLabel={(item) => item.featureName}
              getMeta={(item) => `${item.featureType}${item.active ? "" : " • inactive"}`}
              onEdit={startEditFeature}
              onDelete={(item) => void requestDelete("features", item.id, item.featureName, {
                seasonId: item.seasonId,
                featureType: item.featureType,
                featureCode: item.featureCode ?? "",
                featureName: item.featureName,
                geojson: item.geojson,
                linkedPlotId: item.linkedPlotId ?? "",
                linkedIrrigationLineId: item.linkedIrrigationLineId ?? "",
                linkedValveId: item.linkedValveId ?? "",
                styleJson: item.styleJson,
                displayOrder: item.displayOrder,
                active: item.active,
              })}
            />
          </form>
          <BuilderForms
            dashboard={dashboard}
            plotForm={plotForm}
            setPlotForm={setPlotForm}
            lineForm={lineForm}
            setLineForm={setLineForm}
            valveForm={valveForm}
            setValveForm={setValveForm}
            editingIds={editingIds}
            resetPlotForm={resetPlotForm}
            resetLineForm={resetLineForm}
            resetValveForm={resetValveForm}
            saveResource={(input, onSuccess) => saveResource.mutate(input, { onSuccess })}
            plots={managedPlots}
            lines={managedLines}
            valves={managedValves}
            onEditPlot={startEditPlot}
            onEditLine={startEditLine}
            onEditValve={startEditValve}
            onDeletePlot={(plot) => void requestDelete("plots", plot.id, plot.plotCode, { ...plot, plotName: plot.plotName ?? "", variety: plot.variety ?? "", area: plot.area ?? "", notes: plot.notes ?? "", geoFeatureId: plot.geoFeatureId ?? "" })}
            onDeleteLine={(line) => void requestDelete("irrigation-lines", line.id, line.lineCode, { ...line, lineName: line.lineName ?? "", description: line.description ?? "", geoFeatureId: line.geoFeatureId ?? "" })}
            onDeleteValve={(valve) => void requestDelete("valves", valve.id, valve.valveCode, { ...valve, valveName: valve.valveName ?? "", irrigationLineId: valve.irrigationLineId ?? "", plotId: valve.plotId ?? "", notes: valve.notes ?? "", geoFeatureId: valve.geoFeatureId ?? "" })}
          />
          <form className="record-panel farm-builder-form" onSubmit={saveRule}>
            <h2>{editingIds.rule ? "Edit due rule" : "Due rule"}</h2>
            <select value={ruleForm.plotId} onChange={(event) => setRuleForm({ ...ruleForm, plotId: event.target.value })}><option value="">All plots</option>{dashboard.plots.map((plot) => <option key={plot.id} value={plot.id}>{plot.plotCode}</option>)}</select>
            <select value={ruleForm.activityType} onChange={(event) => setRuleForm({ ...ruleForm, activityType: event.target.value as OperationActivityType })}>{activityOptions.map((item) => <option key={item}>{item}</option>)}</select>
            <input inputMode="numeric" placeholder="Interval days" value={ruleForm.intervalDays} onChange={(event) => setRuleForm({ ...ruleForm, intervalDays: event.target.value })} />
            <input inputMode="numeric" placeholder="Due soon days" value={ruleForm.dueSoonDays} onChange={(event) => setRuleForm({ ...ruleForm, dueSoonDays: event.target.value })} />
            <textarea placeholder="Notes" value={ruleForm.notes} onChange={(event) => setRuleForm({ ...ruleForm, notes: event.target.value })} />
            <div className="farm-form-actions">
              <button type="submit"><Save size={16} />{editingIds.rule ? "Update rule" : "Save rule"}</button>
              {editingIds.rule && <button className="secondary-button" type="button" onClick={resetRuleForm}>Cancel</button>}
            </div>
            <RecordManagerList
              title="Existing due rules"
              items={managedRules}
              getLabel={(item) => `${item.activityType} every ${item.intervalDays} days`}
              getMeta={(item) => `${dashboard.plots.find((plot) => plot.id === item.plotId)?.plotCode ?? "All plots"}${item.active ? "" : " • inactive"}`}
              onEdit={startEditRule}
              onDelete={(item) => void requestDelete("operation-due-rules", item.id, `${item.activityType} rule`)}
            />
          </form>
        </section>}
        {showLog && <section className="record-panel farm-log-panel">
          <header><h2>{editingIds.log ? "Edit operation entry" : "Operation logging"}</h2><button type="button" onClick={() => { resetLogForm(); setShowLog(false); }}>Close</button></header>
          <OperationLogForm dashboard={dashboard} products={products.data?.records ?? []} initial={logForm} onSubmit={submitLog} pending={saveResource.isPending} />
        </section>}
        <section className="record-panel farm-logs-report">
          <h2>Operation logs report</h2>
          <div className="attendance-import-table-wrap report-wide-table">
            <table className="report-data-table"><thead><tr><th>Date</th><th>Activity</th><th>Plot</th><th>Valve</th><th>Product</th><th>Qty</th><th>Performed by</th><th>Remarks</th><th>Actions</th></tr></thead><tbody>
              {logs.map((log) => <tr key={log.id}><td>{log.operationDate}</td><td>{log.activityType}</td><td>{dashboard.plots.find((plot) => plot.id === log.plotId)?.plotCode ?? "-"}</td><td>{dashboard.valves.find((valve) => valve.id === log.valveId)?.valveCode ?? "-"}</td><td>{products.data?.records.find((product) => product.id === log.productId)?.productName ?? log.productNameText ?? "-"}</td><td>{log.totalQty ?? "-"} {log.unit ?? ""}</td><td>{log.performedBy ?? "-"}</td><td>{log.remarks ?? "-"}</td><td><div className="farm-table-actions"><button type="button" onClick={() => startEditLog(log)}><Pencil size={14} />Edit</button><button className="danger-button" type="button" onClick={() => void requestDelete("operation-logs", log.id, "operation log")}><Trash2 size={14} />Delete</button></div></td></tr>)}
            </tbody></table>
          </div>
          <div className="report-wide-table--mobile report-mobile-cards">
            {logs.map((log) => <article className="report-mobile-card" key={`mobile-${log.id}`}>
              <b>{log.activityType} • {log.operationDate}</b>
              <p>{dashboard.plots.find((plot) => plot.id === log.plotId)?.plotCode ?? "-"} • {dashboard.valves.find((valve) => valve.id === log.valveId)?.valveCode ?? "-"}</p>
              <p>{products.data?.records.find((product) => product.id === log.productId)?.productName ?? log.productNameText ?? "-"}</p>
              <p>{log.totalQty ?? "-"} {log.unit ?? ""} • {log.performedBy ?? "-"}</p>
              <div className="farm-table-actions"><button type="button" onClick={() => startEditLog(log)}><Pencil size={14} />Edit</button><button className="danger-button" type="button" onClick={() => void requestDelete("operation-logs", log.id, "operation log")}><Trash2 size={14} />Delete</button></div>
            </article>)}
          </div>
        </section>
        <SideDrawer
          selected={selected}
          dashboard={dashboard}
          logs={logs}
          mode={mode}
          builderHref={`/workspace/${workspaceId}/farms/${farmId}/map-builder`}
          onClose={() => setSelected(null)}
          onQuickLog={quickLog}
          onEditPlot={startEditPlot}
          onEditLine={startEditLine}
          onEditValve={startEditValve}
          onEditWaterAsset={startEditWaterAsset}
          onDeactivatePlot={(plot) => void requestDelete("plots", plot.id, plot.plotCode, { ...plot, plotName: plot.plotName ?? "", variety: plot.variety ?? "", area: plot.area ?? "", notes: plot.notes ?? "", geoFeatureId: plot.geoFeatureId ?? "" })}
          onDeactivateLine={(line) => void requestDelete("irrigation-lines", line.id, line.lineCode, { ...line, lineName: line.lineName ?? "", description: line.description ?? "", geoFeatureId: line.geoFeatureId ?? "" })}
          onDeactivateValve={(valve) => void requestDelete("valves", valve.id, valve.valveCode, { ...valve, valveName: valve.valveName ?? "", irrigationLineId: valve.irrigationLineId ?? "", plotId: valve.plotId ?? "", notes: valve.notes ?? "", geoFeatureId: valve.geoFeatureId ?? "" })}
          onDeleteWaterAsset={(asset) => void requestDelete("water-assets", asset.id, asset.assetName, {
            seasonId: asset.seasonId,
            assetType: asset.assetType,
            assetCode: asset.assetCode,
            assetName: asset.assetName,
            linkedFeatureId: asset.linkedFeatureId ?? "",
            status: asset.status ?? "",
            notes: asset.notes ?? "",
            active: asset.active,
          })}
        />
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
  editingIds,
  resetPlotForm,
  resetLineForm,
  resetValveForm,
  saveResource,
  plots,
  lines,
  valves,
  onEditPlot,
  onEditLine,
  onEditValve,
  onDeletePlot,
  onDeleteLine,
  onDeleteValve,
}: {
  dashboard: NonNullable<ReturnType<typeof useDashboardData>["dashboard"]>;
  plotForm: PlotForm;
  setPlotForm: (form: PlotForm) => void;
  lineForm: LineForm;
  setLineForm: (form: LineForm) => void;
  valveForm: ValveForm;
  setValveForm: (form: ValveForm) => void;
  editingIds: { plot: string | null; line: string | null; valve: string | null };
  resetPlotForm: () => void;
  resetLineForm: () => void;
  resetValveForm: () => void;
  saveResource: (input: { resource: string; input: unknown; id?: string }, onSuccess?: () => void) => void;
  plots: FarmPlot[];
  lines: IrrigationLine[];
  valves: FarmValve[];
  onEditPlot: (plot: FarmPlot) => void;
  onEditLine: (line: IrrigationLine) => void;
  onEditValve: (valve: FarmValve) => void;
  onDeletePlot: (plot: FarmPlot) => void;
  onDeleteLine: (line: IrrigationLine) => void;
  onDeleteValve: (valve: FarmValve) => void;
}) {
  const numeric = (value: string) => value ? Number(value) : null;
  const features = dashboard.features;
  const submit = (resource: string, input: unknown, id: string | null | undefined, onSuccess: () => void) => (event: FormEvent) => {
    event.preventDefault();
    saveResource({ resource, input, id: id ?? undefined }, onSuccess);
  };
  return <>
    <form className="record-panel farm-builder-form" onSubmit={submit("plots", { ...plotForm, treeCount: numeric(plotForm.treeCount), area: numeric(plotForm.area) }, editingIds.plot, resetPlotForm)}>
      <h2>{editingIds.plot ? "Edit plot record" : "Plot record"}</h2><input required placeholder="Plot code" value={plotForm.plotCode} onChange={(event) => setPlotForm({ ...plotForm, plotCode: event.target.value })} /><input placeholder="Plot name" value={plotForm.plotName} onChange={(event) => setPlotForm({ ...plotForm, plotName: event.target.value })} /><input placeholder="Variety" value={plotForm.variety} onChange={(event) => setPlotForm({ ...plotForm, variety: event.target.value })} /><input inputMode="numeric" placeholder="Tree count" value={plotForm.treeCount} onChange={(event) => setPlotForm({ ...plotForm, treeCount: event.target.value })} /><select value={plotForm.geoFeatureId} onChange={(event) => setPlotForm({ ...plotForm, geoFeatureId: event.target.value })}><option value="">Link feature later</option>{features.filter((item) => item.featureType === "plot").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><div className="farm-form-actions"><button type="submit"><Plus size={16} />{editingIds.plot ? "Update plot" : "Save plot"}</button>{editingIds.plot && <button className="secondary-button" type="button" onClick={resetPlotForm}>Cancel</button>}</div>
      <RecordManagerList title="Existing plots" items={plots} getLabel={(item) => item.plotCode} getMeta={(item) => `${item.plotName ?? "Unnamed plot"}${item.active ? "" : " • inactive"}`} onEdit={onEditPlot} onDelete={onDeletePlot} />
    </form>
    <form className="record-panel farm-builder-form" onSubmit={submit("irrigation-lines", lineForm, editingIds.line, resetLineForm)}>
      <h2>{editingIds.line ? "Edit irrigation line" : "Irrigation line"}</h2><input required placeholder="Line code" value={lineForm.lineCode} onChange={(event) => setLineForm({ ...lineForm, lineCode: event.target.value })} /><input placeholder="Line name" value={lineForm.lineName} onChange={(event) => setLineForm({ ...lineForm, lineName: event.target.value })} /><textarea placeholder="Description" value={lineForm.description} onChange={(event) => setLineForm({ ...lineForm, description: event.target.value })} /><select value={lineForm.geoFeatureId} onChange={(event) => setLineForm({ ...lineForm, geoFeatureId: event.target.value })}><option value="">Link feature later</option>{features.filter((item) => item.featureType === "irrigation_line").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><div className="farm-form-actions"><button type="submit"><Plus size={16} />{editingIds.line ? "Update line" : "Save line"}</button>{editingIds.line && <button className="secondary-button" type="button" onClick={resetLineForm}>Cancel</button>}</div>
      <RecordManagerList title="Existing irrigation lines" items={lines} getLabel={(item) => item.lineCode} getMeta={(item) => `${item.lineName ?? "Unnamed line"}${item.active ? "" : " • inactive"}`} onEdit={onEditLine} onDelete={onDeleteLine} />
    </form>
    <form className="record-panel farm-builder-form" onSubmit={submit("valves", { ...valveForm, estimatedTreeCount: numeric(valveForm.estimatedTreeCount) }, editingIds.valve, resetValveForm)}>
      <h2>{editingIds.valve ? "Edit valve" : "Valve"}</h2><input required placeholder="Valve code" value={valveForm.valveCode} onChange={(event) => setValveForm({ ...valveForm, valveCode: event.target.value })} /><input placeholder="Valve name" value={valveForm.valveName} onChange={(event) => setValveForm({ ...valveForm, valveName: event.target.value })} /><select value={valveForm.irrigationLineId} onChange={(event) => setValveForm({ ...valveForm, irrigationLineId: event.target.value })}><option value="">Irrigation line</option>{dashboard.irrigationLines.map((item: IrrigationLine) => <option key={item.id} value={item.id}>{item.lineCode}</option>)}</select><select value={valveForm.plotId} onChange={(event) => setValveForm({ ...valveForm, plotId: event.target.value })}><option value="">Plot</option>{dashboard.plots.map((item: FarmPlot) => <option key={item.id} value={item.id}>{item.plotCode}</option>)}</select><input inputMode="numeric" placeholder="Estimated trees" value={valveForm.estimatedTreeCount} onChange={(event) => setValveForm({ ...valveForm, estimatedTreeCount: event.target.value })} /><select value={valveForm.geoFeatureId} onChange={(event) => setValveForm({ ...valveForm, geoFeatureId: event.target.value })}><option value="">Link feature later</option>{features.filter((item) => item.featureType === "valve").map((item) => <option key={item.id} value={item.id}>{item.featureName}</option>)}</select><div className="farm-form-actions"><button type="submit"><Plus size={16} />{editingIds.valve ? "Update valve" : "Save valve"}</button>{editingIds.valve && <button className="secondary-button" type="button" onClick={resetValveForm}>Cancel</button>}</div>
      <RecordManagerList title="Existing valves" items={valves} getLabel={(item) => item.valveCode} getMeta={(item) => `${item.valveName ?? "Unnamed valve"}${item.active ? "" : " • inactive"}`} onEdit={onEditValve} onDelete={onDeleteValve} />
    </form>
  </>;
}

function RecordManagerList<T>({
  title,
  items,
  getLabel,
  getMeta,
  onEdit,
  onDelete,
}: {
  title: string;
  items: T[];
  getLabel: (item: T) => string;
  getMeta: (item: T) => string;
  onEdit: (item: T) => void;
  onDelete: (item: T) => void;
}) {
  return <div className="farm-record-list">
    <h3>{title}</h3>
    {!items.length && <p className="context-message">No records yet.</p>}
    {items.map((item, index) => <article className="farm-record-list__item" key={index}>
      <div>
        <strong>{getLabel(item)}</strong>
        <small>{getMeta(item)}</small>
      </div>
      <div className="farm-table-actions">
        <button type="button" onClick={() => onEdit(item)}><Pencil size={14} />Edit</button>
        <button className="danger-button" type="button" onClick={() => onDelete(item)}><Trash2 size={14} />Delete</button>
      </div>
    </article>)}
  </div>;
}
