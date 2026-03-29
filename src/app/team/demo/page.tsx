'use client';

import React, {
  useEffect,
  useRef,
  useState,
  ChangeEvent,
  useCallback,
} from 'react';
import Script from 'next/script';
import Papa from 'papaparse';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
} from '@/components/ui/dialog';
import { Header } from '@/components/layout/header';

import { useSession } from 'next-auth/react';

import { useMiniGridHistory } from '@/hooks/useMiniGridHistory';

const GOOGLE_MAPS_API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY || 'YOUR_GOOGLE_MAPS_API_KEY';

function toLiteral(
  pos: google.maps.marker.AdvancedMarkerElement['position']
): google.maps.LatLngLiteral | null {
  if (!pos) return null;
  if (typeof pos.lat === 'function' && typeof pos.lng === 'function') {
    return { lat: pos.lat(), lng: pos.lng() };
  }
  return { lat: pos.lat as number, lng: pos.lng as number };
}

const haversineDistance = (
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
) => {
  const R = 6371e3;
  const deg2rad = (deg: number) => deg * (Math.PI / 180);
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
};

const formatMeters = (m: number) =>
  m.toLocaleString(undefined, { maximumFractionDigits: 0 });
const formatUSD = (v: number) =>
  v.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

const highVoltageColor = '#8B5CF6';
const lowVoltageColor = '#3B82F6';

// ==================== INTERFACES ====================
export interface MarkerPoint {
  name: string;
  type: 'source' | 'terminal' | 'pole';
  lat: number;
  lng: number;
}

export interface MiniGridEdge {
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  lengthMeters: number;
  voltage: 'low' | 'high';
}

export interface MiniGridNode {
  index: number;
  lat: number;
  lng: number;
  name: string;
  type: 'source' | 'terminal' | 'pole';
}

export interface CostBreakdown {
  lowVoltageMeters: number;
  highVoltageMeters: number;
  totalMeters: number;
  lowWireCost: number;
  highWireCost: number;
  wireCost: number;
  poleCount: number;
  poleCost: number;
  pointCount: number;
  grandTotal: number;
  usedPoleCost?: number;
  usedLowCostPerMeter?: number;
  usedHighCostPerMeter?: number;
}

interface MiniGridRun {
  id: string;
  name?: string;
  createdAt: string;
  fileName?: string | null;
  dataPoints: MarkerPoint[];
  miniGridNodes: MiniGridNode[];
  miniGridEdges: MiniGridEdge[];
  costBreakdown: CostBreakdown;
  poleCost: number;
  lowVoltageCost: number;
  highVoltageCost: number;
}

interface Solvers {
  name: string;
  params: SolverParam[];
}

interface SolverParam {
  name: string;
  type?: 'integer' | 'float' | 'number';
  default: number;
  min?: number;
  max?: number;
  description: string;
}

// ==================== MAIN COMPONENT ====================
export default function DemoPage() {
  const mapRef = useRef<HTMLDivElement>(null);
  const [map, setMap] = useState<google.maps.Map | null>(null);
  const polylinesRef = useRef<google.maps.Polyline[]>([]);
  const markersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const markerDragRef = useRef<string | null>(null);

  const [dataPoints, setDataPoints] = useState<MarkerPoint[]>([]);
  const [miniGridEdges, setMiniGridEdges] = useState<MiniGridEdge[]>([]);
  const [miniGridNodes, setMiniGridNodes] = useState<MiniGridNode[]>([]);
  const [originalDataPoints, setOriginalDataPoints] = useState<MarkerPoint[]>(
    []
  );
  const [originalFileName, setOriginalFileName] = useState<string | null>(null);

  const [fileName, setFileName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [computingMiniGrid, setComputingMiniGrid] = useState(false);

  const [poleCost, setPoleCost] = useState<number>(1000);
  const [lowVoltageCost, setLowVoltageCost] = useState<number>(10);
  const [highVoltageCost, setHighVoltageCost] = useState<number>(20);

  const [costBreakdown, setCostBreakdown] = useState<CostBreakdown>({
    lowVoltageMeters: 0,
    highVoltageMeters: 0,
    totalMeters: 0,
    lowWireCost: 0,
    highWireCost: 0,
    wireCost: 0,
    poleCount: 0,
    poleCost: 0,
    pointCount: 0,
    grandTotal: 0,
  });

  const poleCount = miniGridNodes.filter((n) => n.type === 'pole').length;
  const hasPoles = poleCount > 0;

  const [solverOriginalCost, setSolverOriginalCost] = useState<number>(0);
  const costDiff = costBreakdown.grandTotal - solverOriginalCost;
  const isNegative = costDiff <= 0;

  const [selectedCount, setSelectedCount] = useState<number>(10);
  const [isDragOver, setIsDragOver] = useState(false);
  const [allowDragTerminals, setAllowDragTerminals] = useState(true);
  const allowDragTerminalsRef = useRef(true); // Add this line

  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({
    markers: false,
    solver_cost: false,
    export: false,
    savedGrids: false,
  });

  const [isAddPointDialogOpen, setIsAddPointDialogOpen] = useState(false);
  const [pendingPoint, setPendingPoint] = useState<{
    lat: number;
    lng: number;
  } | null>(null);
  const [newPointDetails, setNewPointDetails] = useState({
    name: '',
    type: 'terminal' as 'source' | 'terminal' | 'pole',
  });

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const [solvers, setSolvers] = useState<Solvers[]>([]);
  const [selectedSolverName, setSelectedSolverName] = useState<string>(
    'GreedyIterSteinerSolver'
  );
  const selectedSolver = solvers.find((s) => s.name === selectedSolverName);
  const [paramValues, setParamValues] = useState<Record<string, number>>({});
  const [useExistingPoles, setUseExistingPoles] = useState(false);

  const [calculationResult] = useState<string>('');
  const [calcError, setCalcError] = useState<string | null>(null);

  const [manualPoint, setManualPoint] = useState({
    name: '',
    lat: '',
    lng: '',
    type: 'terminal' as 'source' | 'terminal' | 'pole',
  });

  const [savedRuns, setSavedRuns] = useState<MiniGridRun[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const { saveState, undo, redo, canUndo, canRedo } = useMiniGridHistory({
    dataPoints: [],
    miniGridNodes: [],
    miniGridEdges: [],
    costBreakdown: {
      lowVoltageMeters: 0,
      highVoltageMeters: 0,
      totalMeters: 0,
      lowWireCost: 0,
      highWireCost: 0,
      wireCost: 0,
      poleCount: 0,
      poleCost: 0,
      pointCount: 0,
      grandTotal: 0,
    },
  });

  // 1. Add this near your other refs
  const stateRef = useRef({
    dataPoints,
    miniGridNodes,
    miniGridEdges,
    costBreakdown,
    lowVoltageCost,
    highVoltageCost,
    saveState,
  });

  // 2. Add this effect to sync it automatically
  useEffect(() => {
    stateRef.current = {
      dataPoints,
      miniGridNodes,
      miniGridEdges,
      costBreakdown,
      lowVoltageCost,
      highVoltageCost,
      saveState,
    };
  }, [
    dataPoints,
    miniGridNodes,
    miniGridEdges,
    costBreakdown,
    lowVoltageCost,
    highVoltageCost,
    saveState,
  ]);

  // Helper to bundle current state for the hook
  const captureState = (overrides = {}) => ({
    dataPoints,
    miniGridNodes,
    miniGridEdges,
    costBreakdown,
    ...overrides,
  });

  // ==================== KEYBOARD SHORTCUTS ====================
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // 1. Guard: Do not trigger if the user is typing inside an input box
      const target = e.target as HTMLElement;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) {
        return;
      }

      // 2. Detect Ctrl (Windows/Linux) or Cmd (Mac)
      const isModifierPressed = e.metaKey || e.ctrlKey;

      if (isModifierPressed && e.key.toLowerCase() === 'z') {
        e.preventDefault(); // Stop the browser's default text undo behavior

        if (e.shiftKey) {
          // REDO: Cmd/Ctrl + Shift + Z
          if (canRedo) {
            const s = redo();
            if (s) {
              setDataPoints(s.dataPoints);
              setMiniGridNodes(s.miniGridNodes);
              setMiniGridEdges(s.miniGridEdges);
              setCostBreakdown(s.costBreakdown);
            }
          }
        } else {
          // UNDO: Cmd/Ctrl + Z
          if (canUndo) {
            const s = undo();
            if (s) {
              setDataPoints(s.dataPoints);
              setMiniGridNodes(s.miniGridNodes);
              setMiniGridEdges(s.miniGridEdges);
              setCostBreakdown(s.costBreakdown);
            }
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    // Cleanup the event listener when the component unmounts or state changes
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [canUndo, canRedo, undo, redo]); // Keep dependencies updated

  const { data: session } = useSession();

  useEffect(() => {
    allowDragTerminalsRef.current = allowDragTerminals;
  }, [allowDragTerminals]);

  // ==================== MAP CLICK TO ADD MARKER ====================
  useEffect(() => {
    if (!map) return;

    const clickListener = map.addListener(
      'click',
      (e: google.maps.MapMouseEvent) => {
        if (!e.latLng) return;

        const lat = e.latLng.lat();
        const lng = e.latLng.lng();

        // Optional: ignore clicks that are very close to existing markers
        const tooClose =
          dataPoints.some(
            (p) => haversineDistance(p.lat, p.lng, lat, lng) < 5 // ~5 meters
          ) ||
          miniGridNodes.some(
            (n) => haversineDistance(n.lat, n.lng, lat, lng) < 5
          );

        if (tooClose) return;

        setPendingPoint({ lat, lng });
        setIsAddPointDialogOpen(true);
      }
    );

    // Cleanup
    return () => {
      google.maps.event.removeListener(clickListener);
    };
  }, [map, dataPoints, miniGridNodes]); // Re-attach if points change (optional)

  const handleRemovePoint = useCallback(
    (pointName: string) => {
      // 1. Get the latest state from the Ref to avoid stale closures
      const current = stateRef.current;

      // 2. Filter out the point and its node
      const updatedPoints = current.dataPoints.filter(
        (p) => p.name !== pointName
      );
      const updatedNodes = current.miniGridNodes.filter(
        (n) => n.name !== pointName
      );

      // 3. Critically: Remove any edges connected to this specific point
      // We check if both the start and end of an edge still exist in the new points list
      const updatedEdges = current.miniGridEdges.filter((edge) => {
        const startExists = updatedNodes.some(
          (n) =>
            Math.abs(n.lat - edge.start.lat) < 1e-9 &&
            Math.abs(n.lng - edge.start.lng) < 1e-9
        );
        const endExists = updatedNodes.some(
          (n) =>
            Math.abs(n.lat - edge.end.lat) < 1e-9 &&
            Math.abs(n.lng - edge.end.lng) < 1e-9
        );
        return startExists && endExists;
      });

      // 4. Update React State
      setDataPoints(updatedPoints);
      setMiniGridNodes(updatedNodes);
      setMiniGridEdges(updatedEdges);

      // 5. Push to History
      current.saveState({
        dataPoints: updatedPoints,
        miniGridNodes: updatedNodes,
        miniGridEdges: updatedEdges,
        costBreakdown: current.costBreakdown, // You may want to trigger a cost recalc here
      });
    },
    [saveState] // Only depend on saveState; internal data comes from stateRef
  );

  const handleDeleteEdge = useCallback((clickedEdge: MiniGridEdge) => {
    const current = stateRef.current;

    if (
      !window.confirm(
        `Delete this ${clickedEdge.voltage.toUpperCase()} edge (${formatMeters(
          clickedEdge.lengthMeters
        )} m)?`
      )
    ) {
      return;
    }

    // Remove the edge (handles both forward and reverse direction)
    const updatedEdges = current.miniGridEdges.filter((e) => {
      const sameForward =
        Math.abs(e.start.lat - clickedEdge.start.lat) < 1e-9 &&
        Math.abs(e.start.lng - clickedEdge.start.lng) < 1e-9 &&
        Math.abs(e.end.lat - clickedEdge.end.lat) < 1e-9 &&
        Math.abs(e.end.lng - clickedEdge.end.lng) < 1e-9;

      const sameReverse =
        Math.abs(e.start.lat - clickedEdge.end.lat) < 1e-9 &&
        Math.abs(e.start.lng - clickedEdge.end.lng) < 1e-9 &&
        Math.abs(e.end.lat - clickedEdge.start.lat) < 1e-9 &&
        Math.abs(e.end.lng - clickedEdge.start.lng) < 1e-9;

      return !(sameForward || sameReverse);
    });

    // Calculate cost delta
    const isLow = clickedEdge.voltage === 'low';
    const deltaMeters = clickedEdge.lengthMeters;
    const deltaWire =
      deltaMeters * (isLow ? current.lowVoltageCost : current.highVoltageCost);

    const newCostBreakdown: CostBreakdown = {
      ...current.costBreakdown,
      lowVoltageMeters:
        current.costBreakdown.lowVoltageMeters - (isLow ? deltaMeters : 0),
      highVoltageMeters:
        current.costBreakdown.highVoltageMeters - (isLow ? 0 : deltaMeters),
      totalMeters: current.costBreakdown.totalMeters - deltaMeters,
      lowWireCost: current.costBreakdown.lowWireCost - (isLow ? deltaWire : 0),
      highWireCost:
        current.costBreakdown.highWireCost - (isLow ? 0 : deltaWire),
      wireCost: current.costBreakdown.wireCost - deltaWire,
      grandTotal: current.costBreakdown.grandTotal - deltaWire,
    };

    // Update React state
    setMiniGridEdges(updatedEdges);
    setCostBreakdown(newCostBreakdown);

    // Save to history
    current.saveState({
      dataPoints: current.dataPoints,
      miniGridNodes: current.miniGridNodes,
      miniGridEdges: updatedEdges,
      costBreakdown: newCostBreakdown,
    });
  }, []); // no extra deps needed — everything comes from the live ref

  // ==================== MARKER & DRAG LOGIC ====================
  const createMarker = useCallback(
    (
      point: {
        lat: number;
        lng: number;
        name: string;
        type?: 'source' | 'terminal' | 'pole';
      },
      map: google.maps.Map
    ) => {
      const type = point.type || 'terminal'; // raw uploaded points → treat as 'terminal'

      let displayTitle = point.name;
      if (point.type && !point.name.toLowerCase().includes(`(${point.type}`)) {
        displayTitle = `${point.name} (${point.type})`;
      }

      let iconUrl = 'http://maps.google.com/mapfiles/ms/icons/';
      let labelColor = 'white';
      let scaledSize = new google.maps.Size(36, 36);
      let fontSize = '13px';

      switch (type) {
        case 'source':
          iconUrl += 'green-dot.png';
          labelColor = '#00ff00'; // bright green
          scaledSize = new google.maps.Size(44, 44);
          break;

        case 'terminal':
          iconUrl += 'blue-dot.png';
          labelColor = 'white';
          // keep default size
          break;

        case 'pole':
          iconUrl += 'yellow-dot.png';
          scaledSize = new google.maps.Size(28, 28);
          fontSize = '11px';
          labelColor = '#ffff99'; // light yellow for visibility
          break;

        default:
          iconUrl += 'red-dot.png';
      }

      // Create custom content for AdvancedMarkerElement
      const content = document.createElement('div');
      content.style.display = 'flex';
      content.style.flexDirection = 'column';
      content.style.alignItems = 'center';
      content.style.position = 'relative';

      const iconWrapper = document.createElement('div');
      iconWrapper.style.position = 'relative';
      iconWrapper.style.width = '44px'; // Set to your largest marker width
      iconWrapper.style.height = '44px'; // Set to your largest marker height
      iconWrapper.style.display = 'flex';
      iconWrapper.style.alignItems = 'center';
      iconWrapper.style.justifyContent = 'center';

      const iconImg = document.createElement('img');
      iconImg.src = iconUrl;
      iconImg.style.width = `${scaledSize.width}px`;
      iconImg.style.height = `${scaledSize.height}px`;

      iconWrapper.appendChild(iconImg);

      const labelSpan = document.createElement('span');
      labelSpan.textContent = point.name;
      labelSpan.style.color = labelColor;
      labelSpan.style.fontSize = fontSize;
      labelSpan.style.fontWeight = 'bold';
      labelSpan.style.textShadow = '0 0 2px black'; // Better visibility on satellite map
      labelSpan.style.marginTop = '2px';
      content.appendChild(labelSpan);

      const marker = new google.maps.marker.AdvancedMarkerElement({
        position: { lat: point.lat, lng: point.lng },
        map,
        content,
        title: displayTitle,
        gmpDraggable: true,
      });

      marker.addListener('dragstart', () => {
        const literal = toLiteral(marker.position);
        if (literal) {
          markerDragRef.current = `${literal.lat},${literal.lng}`;
        }
      });

      marker.addListener('drag', () => {
        const currentPos = toLiteral(marker.position);
        const prevStr = markerDragRef.current;
        if (!currentPos || !prevStr) return;

        const [prevLat, prevLng] = prevStr.split(',').map(Number);
        const isPole = point.type === 'pole';

        // 1. RULE: Terminals can only move if allowDragTerminals is true
        // We use the Ref version of the state if you have one, or ensure this
        // function is recreated when allowDragTerminals changes.
        if (!isPole && !allowDragTerminalsRef.current) {
          marker.position = { lat: prevLat, lng: prevLng };
          return;
        }

        let exceedsLimit = false;
        const targetLat = currentPos.lat;
        const targetLng = currentPos.lng;

        // 2. RULE: No edge can exceed 30m
        // We check every polyline connected to this specific marker
        polylinesRef.current.forEach((line) => {
          const path = line.getPath();
          if (path.getLength() !== 2) return;

          const start = path.getAt(0);
          const end = path.getAt(1);

          // Identify if this line is attached to the marker we are dragging
          const isStart =
            Math.abs(start.lat() - prevLat) < 1e-9 &&
            Math.abs(start.lng() - prevLng) < 1e-9;
          const isEnd =
            Math.abs(end.lat() - prevLat) < 1e-9 &&
            Math.abs(end.lng() - prevLng) < 1e-9;

          if (isStart || isEnd) {
            const otherNode = isStart ? end : start;
            const distance = haversineDistance(
              targetLat,
              targetLng,
              otherNode.lat(),
              otherNode.lng()
            );

            if (distance > 30) {
              exceedsLimit = true;
            }
          }
        });

        // 3. ENFORCEMENT: If any rule is broken, snap back and EXIT
        if (exceedsLimit) {
          marker.position = { lat: prevLat, lng: prevLng };
          return;
        }

        // 4. UPDATE VISUALS: If rules are passed, move the lines and update solver
        const costDiff = { low: 0, high: 0 };

        polylinesRef.current.forEach((line) => {
          const path = line.getPath();
          const start = path.getAt(0);
          const end = path.getAt(1);
          const lineType =
            line.get('strokeColor') === lowVoltageColor ? 'low' : 'high';

          let isMatched = false;
          const oldDist = haversineDistance(
            start.lat(),
            start.lng(),
            end.lat(),
            end.lng()
          );

          if (
            Math.abs(start.lat() - prevLat) < 1e-9 &&
            Math.abs(start.lng() - prevLng) < 1e-9
          ) {
            line.setPath([{ lat: targetLat, lng: targetLng }, end]);
            isMatched = true;
          } else if (
            Math.abs(end.lat() - prevLat) < 1e-9 &&
            Math.abs(end.lng() - prevLng) < 1e-9
          ) {
            line.setPath([start, { lat: targetLat, lng: targetLng }]);
            isMatched = true;
          }

          if (isMatched) {
            const newDist = haversineDistance(
              line.getPath().getAt(0).lat(),
              line.getPath().getAt(0).lng(),
              line.getPath().getAt(1).lat(),
              line.getPath().getAt(1).lng()
            );
            costDiff[lineType] += newDist - oldDist;
          }
        });

        // 5. UPDATE STATE: Apply cost changes to the UI
        setCostBreakdown((prev) => {
          const addedWireCost =
            costDiff.low * lowVoltageCost + costDiff.high * highVoltageCost;
          return {
            ...prev,
            lowVoltageMeters: prev.lowVoltageMeters + costDiff.low,
            highVoltageMeters: prev.highVoltageMeters + costDiff.high,
            totalMeters: prev.totalMeters + costDiff.low + costDiff.high,
            wireCost: prev.wireCost + addedWireCost,
            grandTotal: prev.grandTotal + addedWireCost,
          };
        });

        // Update the reference for the next 'drag' tick
        markerDragRef.current = `${targetLat},${targetLng}`;
      });

      // 5. Enforce final snap back when the user lets go of the mouse
      marker.addListener('dragend', () => {
        const prevStr = markerDragRef.current;

        // 1. GUARD: Prevent phantom events from destroying the undo stack
        // If there is no active drag reference, this is a phantom event from unmounting.
        if (!prevStr) return;

        // The prevStr holds the final valid position from the last 'drag' tick
        const [finalLat, finalLng] = prevStr.split(',').map(Number);

        // Snap the visual marker to ensure it rests exactly on the valid coords
        marker.position = { lat: finalLat, lng: finalLng };

        // 2. Grab the absolute latest state to avoid stale closures
        const current = stateRef.current;

        // 2. Calculate newly updated arrays synchronously
        const updatedNodes = current.miniGridNodes.map((n) =>
          n.name === point.name ? { ...n, lat: finalLat, lng: finalLng } : n
        );

        const updatedPoints = current.dataPoints.map((p) =>
          p.name === point.name ? { ...p, lat: finalLat, lng: finalLng } : p
        );

        const updatedEdges = current.miniGridEdges.map((edge) => {
          // Identify if the dragged point was the start or end of this edge
          const isStart =
            Math.abs(edge.start.lat - point.lat) < 1e-9 &&
            Math.abs(edge.start.lng - point.lng) < 1e-9;

          const isEnd =
            Math.abs(edge.end.lat - point.lat) < 1e-9 &&
            Math.abs(edge.end.lng - point.lng) < 1e-9;

          if (isStart || isEnd) {
            const newStart = isStart
              ? { lat: finalLat, lng: finalLng }
              : edge.start;
            const newEnd = isEnd ? { lat: finalLat, lng: finalLng } : edge.end;

            return {
              ...edge,
              start: newStart,
              end: newEnd,
              lengthMeters: haversineDistance(
                newStart.lat,
                newStart.lng,
                newEnd.lat,
                newEnd.lng
              ),
            };
          }
          return edge;
        });

        // 3. Update React State with the newly calculated arrays
        setMiniGridNodes(updatedNodes);
        setDataPoints(updatedPoints);
        setMiniGridEdges(updatedEdges);

        // 4. Save to History EXACTLY the fresh state you just calculated
        current.saveState({
          dataPoints: updatedPoints,
          miniGridNodes: updatedNodes,
          miniGridEdges: updatedEdges,
          costBreakdown: current.costBreakdown,
        });

        markerDragRef.current = null;
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = '×';
      // These coordinates are now relative to the 44x44 wrapper, not the icon size
      deleteBtn.style.position = 'absolute';
      deleteBtn.style.top = '0px';
      deleteBtn.style.right = '0px';
      deleteBtn.style.background = '#ef4444';
      deleteBtn.style.color = 'white';
      deleteBtn.style.border = 'none';
      deleteBtn.style.borderRadius = '9999px';
      deleteBtn.style.width = '10px';
      deleteBtn.style.height = '10px';
      deleteBtn.style.fontSize = '10px';
      deleteBtn.style.lineHeight = '1';
      deleteBtn.style.cursor = 'pointer';
      deleteBtn.style.boxShadow = '0 1px 3px rgba(0,0,0,0.3)';

      deleteBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        // We use window.confirm for a simple check
        if (window.confirm(`Delete ${point.name}?`)) {
          handleRemovePoint(point.name);
        }
      });

      iconWrapper.appendChild(deleteBtn);

      // 4. Assemble the final marker
      content.appendChild(iconWrapper); // Wrapper first
      content.appendChild(labelSpan); // Label second

      return marker;
    },
    []
  );

  const [sidebarWidth, setSidebarWidth] = useState(500); // default width

  const [isResizing, setIsResizing] = useState(false);

  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleMouseMove = (e: MouseEvent) => {
    if (!isResizing) return;

    const newWidth = e.clientX; // ← Changed: now uses left position (clientX)

    if (newWidth >= 320 && newWidth <= 600) {
      setSidebarWidth(newWidth);
    }
  };

  const handleMouseUp = () => {
    setIsResizing(false);
    document.body.style.cursor = 'default';
    document.body.style.userSelect = '';
  };

  // Inside DemoPage component, near your other useEffects
  // Replace the old useEffect with this one
  useEffect(() => {
    if (!isAddPointDialogOpen) return;

    const type = newPointDetails.type;

    // Combine both arrays and find the highest number for this type
    const allPoints = [...dataPoints, ...miniGridNodes];

    const existingNumbers = allPoints
      .filter((p) => p.type === type)
      .map((p) => {
        // Extract number from name like "Terminal 05", "Pole 12", etc.
        const match = p.name.match(/(\d+)$/);
        return match ? parseInt(match[1], 10) : 0;
      })
      .filter((n) => !isNaN(n));

    const maxNumber =
      existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;

    const nextNumber = maxNumber + 1;

    const typeLabel = type.charAt(0).toUpperCase() + type.slice(1);

    setNewPointDetails((prev) => ({
      ...prev,
      name: `${typeLabel} ${String(nextNumber).padStart(2, '0')}`,
    }));
  }, [isAddPointDialogOpen, newPointDetails.type, dataPoints, miniGridNodes]);

  // 1. Wrap initMap in useCallback to stabilize it
  const initMap = useCallback(() => {
    // Only initialize if the global object exists, the ref is ready, and we haven't already set a map state
    if (!window.google?.maps || !mapRef.current || map) return;

    const googleMap = new window.google.maps.Map(mapRef.current, {
      center: { lat: 39.8283, lng: -98.5795 },
      zoom: 4,
      mapTypeId: 'satellite' as google.maps.MapTypeId,
      fullscreenControl: false,
      streetViewControl: false,
      mapId: 'DEMO_MAP_ID',
    });

    setMap(googleMap);
  }, [map]);

  // 2. Add this effect to catch cases where the script is already loaded (navigation back)
  useEffect(() => {
    if (window.google?.maps && mapRef.current && !map) {
      initMap();
    }
  }, [initMap, map]);

  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  });
  // ==================== SOLVERS & PARAMETERS ====================
  useEffect(() => {
    fetch(
      process.env.NEXT_PUBLIC_GET_SOLVERS || 'http://localhost:8000/solvers'
    )
      .then((res) => res.json())
      .then((data) => setSolvers(data.solvers || []));
  }, []);

  useEffect(() => {
    if (!selectedSolver) {
      setParamValues({});
      return;
    }
    const initial: Record<string, number> = {};
    selectedSolver.params.forEach((p) => {
      initial[p.name] = p.default;
    });
    setParamValues(initial);
  }, [selectedSolverName, selectedSolver]);

  const updateParam = (paramName: string, value: string) => {
    const numValue = Number(value);
    if (isNaN(numValue)) return;
    setParamValues((prev) => ({ ...prev, [paramName]: numValue }));
  };

  // ==================== MAP EFFECTS (Markers + Lines) ====================
  useEffect(() => {
    if (!map) return;
    polylinesRef.current.forEach((line) => line.setMap(null));
    polylinesRef.current = [];

    miniGridEdges.forEach((edge) => {
      if (!edge.start || !edge.end) return;
      const color =
        edge.voltage === 'high' ? highVoltageColor : lowVoltageColor;
      const weight = edge.voltage === 'high' ? 6 : 4;

      const polyline = new google.maps.Polyline({
        path: [edge.start, edge.end],
        geodesic: true,
        strokeColor: color,
        strokeOpacity: 0.9,
        strokeWeight: weight,
        map,
      });

      // NEW: Make the edge clickable for deletion
      polyline.set('edgeData', { ...edge }); // safe copy
      polyline.addListener('click', () => {
        const edgeData = polyline.get('edgeData') as MiniGridEdge;
        if (edgeData) handleDeleteEdge(edgeData);
      });

      polylinesRef.current.push(polyline);
    });
  }, [map, miniGridEdges]);

  // ==================== FILE HANDLING, SOLVER, etc. ====================
  const getSolversURL =
    process.env.NEXT_PUBLIC_GET_SOLVERS || 'http://localhost:8000/solvers';

  useEffect(() => {
    if (!session?.user?.id) return;

    const fetchSaved = async () => {
      setLoadingSaved(true);
      try {
        const res = await fetch('/api/minigrids');
        if (res.ok) {
          const data = await res.json();
          setSavedRuns(data);
        }
      } catch (err) {
        console.error('Failed to load saved runs', err);
      } finally {
        setLoadingSaved(false);
      }
    };

    fetchSaved();
  }, [session?.user?.id]);

  // ==================== MARKER RENDERING ====================
  useEffect(() => {
    if (!map) return;

    // Clear old markers safely
    markersRef.current.forEach((marker) => {
      google.maps.event.clearInstanceListeners(marker);
      marker.map = null;
    });
    markersRef.current = [];

    // Combine points - miniGridNodes has priority
    const allPointsMap = new Map<string, MiniGridNode | MarkerPoint>();

    miniGridNodes.forEach((node) => {
      if (node?.name) allPointsMap.set(node.name, node);
    });

    dataPoints.forEach((point) => {
      if (point?.name && !allPointsMap.has(point.name)) {
        allPointsMap.set(point.name, point);
      }
    });

    const pointsToShow = Array.from(allPointsMap.values());

    if (pointsToShow.length === 0) return;

    const bounds = new google.maps.LatLngBounds();
    let hasValidPoints = false;

    pointsToShow.forEach((point) => {
      if (isNaN(point.lat) || isNaN(point.lng)) return;

      hasValidPoints = true;

      const marker = createMarker(
        {
          lat: point.lat,
          lng: point.lng,
          name: point.name,
          type: point.type,
        },
        map
      );

      markersRef.current.push(marker);
      bounds.extend({ lat: point.lat, lng: point.lng });
    });

    // Auto-fit when appropriate
    if (hasValidPoints && pointsToShow.length <= 20) {
      setTimeout(() => {
        map.fitBounds(bounds, { bottom: 80, left: 80, right: 80, top: 80 });
      }, 100);
    }
  }, [map, miniGridNodes, dataPoints, createMarker]);

  useEffect(() => {
    fetch(getSolversURL)
      .then((res) => res.json())
      .then((data) => setSolvers(data.solvers));
  }, [getSolversURL]);

  useEffect(() => {
    if (!selectedSolver) {
      setParamValues({});
      return;
    }

    const initialValues: Record<string, number> = {};
    selectedSolver.params.forEach((p) => {
      initialValues[p.name] = p.default;
    });

    setParamValues(initialValues);
  }, [selectedSolver, selectedSolverName]);

  const handleConfirmNewPoint = () => {
    if (!pendingPoint) return;

    const newLocation: MarkerPoint = {
      name: newPointDetails.name,
      type: newPointDetails.type,
      lat: pendingPoint.lat,
      lng: pendingPoint.lng,
    };

    const updatedPoints = [...dataPoints, newLocation];
    const updatedNodes: MiniGridNode[] = [
      ...miniGridNodes,
      { ...newLocation, index: miniGridNodes.length },
    ];

    // Update React State
    setDataPoints(updatedPoints);
    setMiniGridNodes(updatedNodes);

    // Save to History (Pass the updated arrays directly)
    saveState(
      captureState({
        dataPoints: updatedPoints,
        miniGridNodes: updatedNodes,
        miniGridEdges: [...miniGridEdges],
        costBreakdown: { ...costBreakdown },
      })
    );

    setIsAddPointDialogOpen(false);
    setPendingPoint(null);
  };

  const handleAddCoordinatesManually = (e: React.FormEvent) => {
    e.preventDefault();
    const lat = parseFloat(manualPoint.lat);
    const lng = parseFloat(manualPoint.lng);

    if (isNaN(lat) || isNaN(lng)) {
      alert('Please enter valid latitude and longitude numbers.');
      return;
    }

    const newPoint: MarkerPoint = {
      name: manualPoint.name || `Manual Point ${dataPoints.length + 1}`,
      type: manualPoint.type,
      lat: lat,
      lng: lng,
    };

    setDataPoints((prev) => [...prev, newPoint]);

    // Reset form
    setManualPoint({ name: '', lat: '', lng: '', type: 'terminal' });

    setAllowDragTerminals(true);

    saveState(captureState({}));
  };

  // Enhanced parseKml to handle solved KMLs
  const parseKml = (
    text: string
  ): {
    nodes: MiniGridNode[];
    edges: MiniGridEdge[];
    costBreakdown: CostBreakdown;
  } => {
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, 'application/xml');

    if (xml.getElementsByTagName('parsererror').length > 0) {
      console.error('KML parsing error');
      return {
        nodes: [],
        edges: [],
        costBreakdown: {
          lowVoltageMeters: 0,
          highVoltageMeters: 0,
          totalMeters: 0,
          lowWireCost: 0,
          highWireCost: 0,
          wireCost: 0,
          poleCount: 0,
          poleCost: 0,
          pointCount: 0,
          grandTotal: 0,
        },
      };
    }

    const placemarks = Array.from(xml.getElementsByTagName('Placemark'));
    const nodes: MiniGridNode[] = [];
    const edges: MiniGridEdge[] = [];

    placemarks.forEach((pm) => {
      const nameEl = pm.getElementsByTagName('name')[0];
      const name = nameEl?.textContent?.trim() || '';

      const descEl = pm.getElementsByTagName('description')[0];
      let descText = descEl?.textContent?.trim() || '';

      // Clean descText: remove tags, replace nbsp, bullet
      descText = descText
        .replace(/<[^>]+>/g, '') // remove HTML tags
        .replace(/\xa0/g, ' ') // nbsp to space
        .replace(/• /g, '') // remove bullet
        .trim();

      const pointEl = pm.getElementsByTagName('Point')[0];
      const lineEl = pm.getElementsByTagName('LineString')[0];

      if (pointEl) {
        const coordsText =
          pointEl.getElementsByTagName('coordinates')[0]?.textContent?.trim() ||
          '';
        if (!coordsText) return;

        const [lngStr, latStr] = coordsText.split(',');
        const lng = parseFloat(lngStr);
        const lat = parseFloat(latStr);
        if (isNaN(lat) || isNaN(lng)) return;

        // Skip summary point at (0,0)
        if (lat === 0 && lng === 0 && name === 'Mini-Grid Cost Summary') {
          // Parse cost summary
          const lines = descText
            .split(/\n+/)
            .map((l) => l.trim())
            .filter((l) => l);

          lines.forEach((line) => {
            if (line.startsWith('Grand Total:')) {
              costBreakdown.grandTotal = parseFloat(
                line.split(':')[1].replace(/[^0-9.]/g, '')
              );
            } else if (line.startsWith('Wire:')) {
              costBreakdown.wireCost = parseFloat(
                line.split(':')[1].replace(/[^0-9.]/g, '')
              );
            } else if (line.startsWith('Low:')) {
              const parts = line.split(':')[1].split(' → ');
              costBreakdown.lowVoltageMeters = parseFloat(
                parts[0].replace(/[^0-9.]/g, '')
              );
              costBreakdown.lowWireCost = parseFloat(
                parts[1].replace(/[^0-9.]/g, '')
              );
            } else if (line.startsWith('High:')) {
              const parts = line.split(':')[1].split(' → ');
              costBreakdown.highVoltageMeters = parseFloat(
                parts[0].replace(/[^0-9.]/g, '')
              );
              costBreakdown.highWireCost = parseFloat(
                parts[1].replace(/[^0-9.]/g, '')
              );
            } else if (line.startsWith('Poles:')) {
              const parts = line.split(':')[1].split(' × ');
              costBreakdown.poleCount = parseInt(parts[0]);
              costBreakdown.usedPoleCost = parseFloat(
                parts[1].replace(/[^0-9.]/g, '')
              );
              costBreakdown.poleCost =
                costBreakdown.poleCount * (costBreakdown.usedPoleCost || 0);
            } else if (line.startsWith('Nodes:')) {
              costBreakdown.pointCount = parseInt(
                line.split('Nodes:')[1].split(' • ')[0]
              );
            }
          });

          if (costBreakdown) {
            costBreakdown.totalMeters =
              costBreakdown.lowVoltageMeters + costBreakdown.highVoltageMeters;
          }

          return;
        }

        // Parse description lines for Type, Index
        const descLines = descText.split(/\n+/).map((l) => l.trim());
        let type: 'source' | 'terminal' | 'pole' = 'terminal';
        let index = -1;

        descLines.forEach((l) => {
          if (l.startsWith('Type:'))
            type = l.split(':')[1].trim() as 'source' | 'terminal' | 'pole';
          if (l.startsWith('Index:')) index = parseInt(l.split(':')[1].trim());
        });

        nodes.push({ index, lat, lng, name, type });
      } else if (lineEl) {
        // Edge (LineString)
        const coordsText =
          lineEl.getElementsByTagName('coordinates')[0]?.textContent?.trim() ||
          '';
        const coords = coordsText.split(/\s+/).filter((c) => c);
        if (coords.length < 2) return;

        const [startLngStr, startLatStr] = coords[0].split(',');
        const [endLngStr, endLatStr] = coords[1].split(',');

        const start = {
          lat: parseFloat(startLatStr),
          lng: parseFloat(startLngStr),
        };
        const end = { lat: parseFloat(endLatStr), lng: parseFloat(endLngStr) };

        // Voltage from name: "Line X (voltage)"
        let voltage: 'low' | 'high' = 'low';
        const nameLower = name.toLowerCase();
        if (nameLower.includes('(high)')) voltage = 'high';

        // Length from description: "Length: N m"
        let lengthMeters = 0;
        const descLines = descText.split(/\n+/).map((l) => l.trim());
        descLines.forEach((l) => {
          if (l.startsWith('Length:')) {
            lengthMeters = parseFloat(l.split(':')[1].replace(/[^0-9.]/g, ''));
          }
        });

        edges.push({ start, end, lengthMeters, voltage });
      }
    });

    return { nodes, edges, costBreakdown };
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow uploading the same file name again
    if (!file) return;

    processFile(file);
    setAllowDragTerminals(true);
    setExpandedSections({
      markers: false,
      solver_cost: true,
      export: false,
      savedGrids: false,
    });
  };

  const processFile = (file: File) => {
    // Clear old visuals immediately (no saveState yet)
    setMiniGridEdges([]);
    setMiniGridNodes([]);
    setCostBreakdown({
      lowVoltageMeters: 0,
      highVoltageMeters: 0,
      totalMeters: 0,
      lowWireCost: 0,
      highWireCost: 0,
      wireCost: 0,
      poleCount: 0,
      poleCost: 0,
      pointCount: 0,
      grandTotal: 0,
    });
    setCalcError(null);
    setError(null);
    setDataPoints([]);
    setFileName(file.name);
    setOriginalFileName(file.name);
    setLoading(true);

    const lowerName = file.name.toLowerCase();

    if (lowerName.endsWith('.kml')) {
      // ── KML branch ─────────────────────────────────────
      const reader = new FileReader();
      reader.onload = () => {
        const text = reader.result as string;
        try {
          const parsed = parseKml(text);

          if (parsed.nodes.length === 0 && parsed.edges.length === 0) {
            setError('No valid data found in the KML file.');
            setLoading(false);
            return;
          }

          // Filter and prepare the exact state we will save
          const validNodes = parsed.nodes
            .filter((n) => !isNaN(n.lat) && !isNaN(n.lng))
            .map((n, idx) => ({
              ...n,
              index: n.index >= 0 ? n.index : idx,
            }));

          const originalPoints: MarkerPoint[] = validNodes
            .filter((n) => n.type !== 'pole')
            .map((n) => ({
              name: n.name,
              type: n.type,
              lat: n.lat,
              lng: n.lng,
            }));

          const newCostBreakdown = parsed.costBreakdown || {
            lowVoltageMeters: 0,
            highVoltageMeters: 0,
            totalMeters: 0,
            lowWireCost: 0,
            highWireCost: 0,
            wireCost: 0,
            poleCount: 0,
            poleCost: 0,
            pointCount: 0,
            grandTotal: 0,
          };

          // ─────────────────────────────────────────────────────
          // UPDATE UI STATE
          // ─────────────────────────────────────────────────────
          setMiniGridNodes(validNodes);
          setMiniGridEdges(parsed.edges);
          setDataPoints(originalPoints);
          setOriginalDataPoints(originalPoints);
          setCostBreakdown(newCostBreakdown);

          // Restore per-unit costs if they were saved in the KML
          if (parsed.costBreakdown) {
            const cb = parsed.costBreakdown;
            setPoleCost(
              cb.usedPoleCost || cb.poleCost / Math.max(cb.poleCount, 1) || 100
            );
            const lowM = cb.lowVoltageMeters || 0;
            setLowVoltageCost(lowM > 0 ? cb.lowWireCost / lowM : 10);
            const highM = cb.highVoltageMeters || 0;
            setHighVoltageCost(highM > 0 ? cb.highWireCost / highM : 20);
          }

          // Auto-fit map
          setTimeout(() => {
            if (map && validNodes.length > 0) {
              const bounds = new google.maps.LatLngBounds();
              validNodes.forEach((n) =>
                bounds.extend({ lat: n.lat, lng: n.lng })
              );
              map.fitBounds(bounds, {
                bottom: 80,
                left: 80,
                right: 80,
                top: 80,
              });
            }
          }, 300);

          // ─────────────────────────────────────────────────────
          // SAVE THE CORRECT NEW STATE TO HISTORY (this fixes redo)
          // ─────────────────────────────────────────────────────
          saveState({
            dataPoints: originalPoints,
            miniGridNodes: validNodes,
            miniGridEdges: parsed.edges,
            costBreakdown: newCostBreakdown,
          });
        } catch (err) {
          setError('Error parsing KML file.');
          console.error(err);
        } finally {
          setLoading(false);
        }
      };

      reader.onerror = () => {
        setError('Failed to read KML file.');
        setLoading(false);
      };
      reader.readAsText(file);
    } else {
      // ── CSV branch ─────────────────────────────────────
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase(),
        complete: (result) => {
          try {
            const rows = result.data as Record<string, string>[];

            const parsedPoints: MarkerPoint[] = rows
              .map((row) => {
                const name = row.name?.trim() || row['name'] || 'Unnamed';
                const typeStr = row.type?.trim() || row['type'] || 'terminal';
                const latStr = row.latitude || row.lat || '';
                const lngStr = row.longitude || row.lng || row.logitude || '';

                const lat = parseFloat(latStr);
                const lng = parseFloat(lngStr);

                if (isNaN(lat) || isNaN(lng)) return null;

                const type =
                  typeStr.toLowerCase() === 'source' ? 'source' : 'terminal';

                return { name, type, lat, lng };
              })
              .filter((p): p is MarkerPoint => p !== null);

            if (parsedPoints.length === 0) {
              setError(
                'No valid rows found. Expected columns: Name, Type (source/terminal), Latitude, Longitude.'
              );
            } else {
              // ─────────────────────────────────────────────────────
              // UPDATE UI STATE
              // ─────────────────────────────────────────────────────
              setDataPoints(parsedPoints);
              setOriginalDataPoints(parsedPoints);

              // ─────────────────────────────────────────────────────
              // SAVE THE CORRECT NEW STATE TO HISTORY (this fixes redo)
              // ─────────────────────────────────────────────────────
              saveState({
                dataPoints: parsedPoints,
                miniGridNodes: [], // CSV has no poles/edges yet
                miniGridEdges: [],
                costBreakdown: {
                  lowVoltageMeters: 0,
                  highVoltageMeters: 0,
                  totalMeters: 0,
                  lowWireCost: 0,
                  highWireCost: 0,
                  wireCost: 0,
                  poleCount: 0,
                  poleCost: 0,
                  pointCount: 0,
                  grandTotal: 0,
                },
              });
            }
          } catch (err) {
            setError('Error parsing CSV file.');
            console.error(err);
          } finally {
            setLoading(false);
          }
        },
        error: (err) => {
          setError('Failed to read file.');
          console.error(err);
          setLoading(false);
        },
      });
    }
  };

  const generateTestData = (count: number) => {
    // First, clear old derived state (but do NOT save yet)
    setMiniGridEdges([]);
    setSolverOriginalCost(0);
    setCostBreakdown({
      lowVoltageMeters: 0,
      highVoltageMeters: 0,
      totalMeters: 0,
      lowWireCost: 0,
      highWireCost: 0,
      wireCost: 0,
      poleCount: 0,
      poleCost: 0,
      pointCount: 0,
      grandTotal: 0,
    });
    setCalcError(null);
    setError(null);
    setFileName(null);

    // Generate the new points
    const centerLat = 33.77728650419152;
    const centerLng = -84.39617097270636;
    const latRange = 0.001;
    const lngRange = 0.001 / Math.cos((centerLat * Math.PI) / 180);

    const points: MarkerPoint[] = [];
    const maxAttempts = count * 10;
    let attempts = 0;

    while (points.length < count && attempts < maxAttempts) {
      const latOffset = (Math.random() - 0.5) * latRange * 2;
      const lngOffset = (Math.random() - 0.5) * lngRange * 2;

      const lat = parseFloat((centerLat + latOffset).toFixed(8));
      const lng = parseFloat((centerLng + lngOffset).toFixed(8));

      const isDuplicate = points.some(
        (point) =>
          Math.abs(point.lat - lat) < 0.0001 &&
          Math.abs(point.lng - lng) < 0.0001
      );

      if (!isDuplicate) {
        const type = points.length === 0 ? 'source' : 'terminal';
        const name =
          points.length === 0
            ? 'Source'
            : `Terminal ${String(points.length).padStart(2, '0')}`;

        points.push({ name, type, lat, lng });
      }
      attempts++;
    }

    if (points.length < count) {
      throw new Error(`Could not generate ${count} unique markers.`);
    }

    const newDataPoints = points; // we already have the array
    const newOriginalDataPoints = points;

    const newState = {
      dataPoints: newDataPoints,
      miniGridNodes: [], // you clear these
      miniGridEdges: [],
      costBreakdown: {
        lowVoltageMeters: 0,
        highVoltageMeters: 0,
        totalMeters: 0,
        lowWireCost: 0,
        highWireCost: 0,
        wireCost: 0,
        poleCount: 0,
        poleCost: 0,
        pointCount: 0,
        grandTotal: 0,
      },
    };

    // Now update the UI
    setDataPoints(newDataPoints);
    setOriginalDataPoints(newOriginalDataPoints);
    setMiniGridNodes([]);
    setMiniGridEdges([]);
    setCostBreakdown(newState.costBreakdown);
    setFileName(null);

    setExpandedSections({
      markers: false,
      solver_cost: true,
      export: false,
      savedGrids: false,
    });
    setAllowDragTerminals(true);

    // Save the CORRECT new state
    saveState(newState);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);

    const files = e.dataTransfer.files;
    if (files.length === 0) return;

    const file = files[0];
    const name = file.name.toLowerCase();

    if (
      file.type === 'text/csv' ||
      name.endsWith('.csv') ||
      name.endsWith('.kml') ||
      file.type === 'application/vnd.google-earth.kml+xml'
    ) {
      processFile(file);
    } else {
      setError('Please drop a CSV or KML file.');
    }
  };

  const handleResetMap = () => {
    // Clear map visuals
    markersRef.current.forEach((marker) => {
      marker.map = null;
    });
    markersRef.current = [];

    polylinesRef.current.forEach((line) => {
      line.setMap(null);
    });
    polylinesRef.current = [];

    // Reset state
    setDataPoints(originalDataPoints); // if you're using the originalPoints state
    setSolverOriginalCost(0);
    setMiniGridNodes([]);
    setMiniGridEdges([]);
    setCostBreakdown({
      lowVoltageMeters: 0,
      highVoltageMeters: 0,
      totalMeters: 0,
      lowWireCost: 0,
      highWireCost: 0,
      wireCost: 0,
      poleCount: 0,
      poleCost: 0,
      pointCount: 0,
      grandTotal: 0,
    });
    setCalcError(null);
    setError(null);
    setFileName(originalFileName);
    setComputingMiniGrid(false);

    // Optional: reset map view to a default area
    if (map) {
      map.setCenter({ lat: 39.8283, lng: -98.5795 }); // US center
      map.setZoom(4);

      // Or reset to your test data area, e.g.:
      // map.setCenter({ lat: 33.777, lng: -84.396 });
      // map.setZoom(14);
    }

    console.log('Map and data reset');
  };

  const handleRunSolver = async () => {
    const pointsToSend =
      useExistingPoles && hasPoles
        ? miniGridNodes // ← includes ALL existing poles + original terminals/source
        : dataPoints; // ← only the original uploaded/added points (no solver poles)

    console.log(
      `[handleRunSolver] Sending ${pointsToSend.length} points to backend`
    );
    console.log(
      `[handleRunSolver] Using existing poles? ${useExistingPoles && hasPoles ? 'YES' : 'NO'} (${pointsToSend.filter((p) => p.type === 'pole').length} poles)`
    );

    if (pointsToSend.length < 2) {
      alert('Need at least 2 points to run solver.');
      return;
    }

    setComputingMiniGrid(true);
    setSolverOriginalCost(0);
    setMiniGridEdges([]);
    setCostBreakdown({
      lowVoltageMeters: 0,
      highVoltageMeters: 0,
      totalMeters: 0,
      lowWireCost: 0,
      highWireCost: 0,
      wireCost: 0,
      poleCount: 0,
      poleCost: 0,
      pointCount: 0,
      grandTotal: 0,
    }); // ← clear previous breakdown
    setCalcError(null);

    const backendUrl =
      process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000/solve';

    const startTime = performance.now();
    const debug = 0;

    try {
      const res = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          solver: selectedSolverName,
          params: paramValues,
          points: pointsToSend,
          costs: {
            poleCost: poleCost || 0,
            lowVoltageCostPerMeter: lowVoltageCost || 0,
            highVoltageCostPerMeter: highVoltageCost || 0,
          },
          debug: debug,
        }),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.detail || errData.error || 'Solve failed');
      }

      const endTime = performance.now();
      const durationMs = endTime - startTime;
      const durationSec = (durationMs / 1000).toFixed(2);

      console.log(
        `%c[API Request] Solve took ${durationMs.toFixed(0)} ms (${durationSec} sec)`,
        'background: #1e293b; color: #60a5fa; padding: 4px 8px; border-radius: 4px;'
      );

      const data = await res.json();

      if (debug) {
        console.log('Solver result:', data);
      }

      if (data.error) throw new Error(data.error);

      // ────────────────────────────────────────────────
      // Backend now already gives us everything we need
      // ────────────────────────────────────────────────
      // Use pre-computed values from backend
      const {
        totalLowVoltageMeters = 0,
        totalHighVoltageMeters = 0,
        numPolesUsed = 0,
        poleCostEstimate = 0,
        lowWireCostEstimate = 0,
        highWireCostEstimate = 0,
        totalWireCostEstimate = 0,
        totalCostEstimate = 0,
        pointCount = 0,
        usedCosts, // optional – for display/debug
      } = data;

      // ─────────────────────────────────────────────────────────────
      //  BUILD THE NEW STATE SNAPSHOT FIRST (before any setState)
      // ─────────────────────────────────────────────────────────────
      const newMiniGridNodes = data.nodes || [];
      const newMiniGridEdges = (data.edges || []).map((e: MiniGridEdge) => ({
        start: e.start,
        end: e.end,
        lengthMeters: e.lengthMeters ?? 0,
        voltage: e.voltage ?? 'low',
      }));

      const newCostBreakdown = {
        lowVoltageMeters: totalLowVoltageMeters,
        highVoltageMeters: totalHighVoltageMeters,
        totalMeters: totalLowVoltageMeters + totalHighVoltageMeters,
        lowWireCost: lowWireCostEstimate,
        highWireCost: highWireCostEstimate,
        wireCost: totalWireCostEstimate,
        poleCount: numPolesUsed,
        poleCost: poleCostEstimate,
        pointCount: pointCount,
        grandTotal: totalCostEstimate,
        usedPoleCost: usedCosts?.poleCost,
        usedLowCostPerMeter: usedCosts?.lowVoltageCostPerMeter,
        usedHighCostPerMeter: usedCosts?.highVoltageCostPerMeter,
      };

      const newDataPoints: MarkerPoint[] = newMiniGridNodes
        .filter((n: MiniGridNode) => n.type !== 'pole')
        .map((n: MiniGridNode) => ({
          name: n.name,
          type: n.type,
          lat: n.lat,
          lng: n.lng,
        }));

      // Now update React state
      setDataPoints(newDataPoints);
      setMiniGridNodes(newMiniGridNodes);
      setMiniGridEdges(newMiniGridEdges);
      setCostBreakdown(newCostBreakdown);

      // Save the CORRECT solved state to history
      saveState({
        dataPoints: newDataPoints, // input points usually don't change
        miniGridNodes: newMiniGridNodes,
        miniGridEdges: newMiniGridEdges,
        costBreakdown: newCostBreakdown,
      });

      setSolverOriginalCost(totalCostEstimate);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to run solver';
      setCalcError(message);
      console.error('Solver error:', err);
    } finally {
      setComputingMiniGrid(false);
    }
    setAllowDragTerminals(false);
    setExpandedSections({
      markers: false,
      solver_cost: false,
      export: true,
      savedGrids: false,
    });
  };

  const generateRandomCosts = () => {
    // Generate realistic cost ranges for mini-grid components
    const poleCost = Math.round((100 + Math.random() * 200) * 100) / 100; // $100-300
    const lowVoltageCost = Math.round((1.5 + Math.random() * 3) * 100) / 100; // $1.50-4.50/m
    const highVoltageCost = Math.round((3 + Math.random() * 4) * 100) / 100; // $3-7/m

    setPoleCost(poleCost);
    setLowVoltageCost(lowVoltageCost);
    setHighVoltageCost(highVoltageCost);
  };

  const downloadKml = () => {
    if (miniGridNodes.length === 0 || miniGridEdges.length === 0) return;

    const escapeXml = (str: string) =>
      str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    const formatCost = (v: number) =>
      v.toLocaleString(undefined, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 0,
        maximumFractionDigits: 0,
      });

    const kmlStyles = `
    <Style id="source">
      <IconStyle><color>ff00cc00</color><scale>1.5</scale></IconStyle>
      <LabelStyle><color>ff00ff00</color><scale>1.1</scale></LabelStyle>
    </Style>
    <Style id="terminal">
      <IconStyle><color>ff3366ff</color><scale>1.3</scale></IconStyle>
      <LabelStyle><scale>1.0</scale></LabelStyle>
    </Style>
    <Style id="pole">
      <IconStyle><color>ffffff66</color><scale>1.1</scale></IconStyle>
      <LabelStyle><color>ffffffff</color><scale>0.85</scale></LabelStyle>
    </Style>
    <Style id="lowVoltage">
      <LineStyle><color>aa3b82f6</color><width>5</width></LineStyle>
    </Style>
    <Style id="highVoltage">
      <LineStyle><color>aa8b5cf6</color><width>7</width></LineStyle>
    </Style>
    <Style id="summary">
      <BalloonStyle>
        <text><![CDATA[<h3>$[name]</h3><p>$[description]</p>]]></text>
      </BalloonStyle>
    </Style>
  `;

    // Nodes
    let nodesKml = '';
    miniGridNodes.forEach((node) => {
      const styleId =
        node.type === 'source'
          ? 'source'
          : node.type === 'terminal'
            ? 'terminal'
            : 'pole';
      const displayName =
        node.type === 'pole'
          ? `Pole ${String(node.index).padStart(3, '0')}`
          : escapeXml(node.name);

      nodesKml += `
      <Placemark>
        <name>${displayName}</name>
        <styleUrl>#${styleId}</styleUrl>
        <description><![CDATA[
          <b>${escapeXml(node.name)}</b><br/>
          Type: ${node.type}<br/>
          Index: ${node.index}<br/>
          Lat,Lng: ${node.lat.toFixed(7)}, ${node.lng.toFixed(7)}
        ]]></description>
        <Point>
          <coordinates>${node.lng.toFixed(8)},${node.lat.toFixed(8)},0</coordinates>
        </Point>
      </Placemark>`;
    });

    // Edges
    let linesKml = '';
    miniGridEdges.forEach((edge, i) => {
      const styleId = edge.voltage === 'high' ? 'highVoltage' : 'lowVoltage';
      const lengthM = Math.round(edge.lengthMeters);
      const costPerM =
        edge.voltage === 'high' ? highVoltageCost : lowVoltageCost;
      const edgeCost = Math.round(lengthM * costPerM);

      linesKml += `
      <Placemark>
        <name>Line ${i + 1} (${edge.voltage})</name>
        <styleUrl>#${styleId}</styleUrl>
        <description><![CDATA[
          <b>Segment ${i + 1}</b><br/>
          Voltage: ${edge.voltage}<br/>
          Length: ${lengthM.toLocaleString()} m<br/>
          Est. cost: ${formatCost(edgeCost)}
        ]]></description>
        <LineString>
          <tessellate>1</tessellate>
          <coordinates>
            ${edge.start.lng.toFixed(8)},${edge.start.lat.toFixed(8)},0
            ${edge.end.lng.toFixed(8)},${edge.end.lat.toFixed(8)},0
          </coordinates>
        </LineString>
      </Placemark>`;
    });

    // Summary
    const summaryDescription = costBreakdown
      ? `
    <b>Grand Total:</b> ${formatCost(costBreakdown.grandTotal)}<br/>
    <b>Wire:</b> ${formatCost(costBreakdown.wireCost)}<br/>
      • Low: ${formatMeters(costBreakdown.lowVoltageMeters)} m → ${formatCost(costBreakdown.lowWireCost)}<br/>
      • High: ${formatMeters(costBreakdown.highVoltageMeters)} m → ${formatCost(costBreakdown.highWireCost)}<br/>
    <b>Poles:</b> ${costBreakdown.poleCount} × ${formatCost(costBreakdown.usedPoleCost ?? poleCost)}<br/>
    <br/>Nodes: ${miniGridNodes.length} • Segments: ${miniGridEdges.length}
  `
      : 'No cost data available';

    let summaryLat = 0;
    let summaryLng = 0;

    // Find the source node
    const sourceNode = miniGridNodes.find((node) => node.type === 'source');
    if (sourceNode) {
      summaryLat = sourceNode.lat;
      summaryLng = sourceNode.lng;
    } else {
      // Fallback: use the first node if no explicit source (rare)
      if (miniGridNodes.length > 0) {
        summaryLat = miniGridNodes[0].lat;
        summaryLng = miniGridNodes[0].lng;
      }
      console.warn(
        'No source node found — using first node for summary position'
      );
    }

    const offsetMeters = 3; // ~15 meters north-east
    const offsetLat = summaryLat + offsetMeters / 111111; // rough 1° lat ≈ 111 km
    const offsetLng =
      summaryLng +
      offsetMeters / (111111 * Math.cos((summaryLat * Math.PI) / 180));

    const summaryPlacemark = `
    <Placemark>
      <name>Mini-Grid Cost Summary</name>
      <styleUrl>#summary</styleUrl>
      <description><![CDATA[${summaryDescription}]]></description>
      <coordinates>${offsetLng.toFixed(8)},${offsetLat.toFixed(8)},0</coordinates>;
    </Placemark>
  `;

    // Assemble final KML
    const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Mini-Grid • ${fileName || 'Solved Network'}</name>
    <open>1</open>

    ${kmlStyles}

    <Folder>
      <name>Nodes and Poles</name>
      <open>1</open>
      ${nodesKml}
    </Folder>

    <Folder>
      <name>Power Lines</name>
      <open>1</open>
      ${linesKml}
    </Folder>

    <Folder>
      <name>Summary</name>
      ${summaryPlacemark}
    </Folder>

  </Document>
</kml>`;

    // Download
    const blob = new Blob([kml], {
      type: 'application/vnd.google-earth.kml+xml',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `minigrid_${new Date().toISOString().slice(0, 10)}.kml`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const loadSavedRun = (run: MiniGridRun) => {
    console.log('Loading saved mini-grid:', run.id, run.name || '(no name)');

    // Log what we actually received (for debugging)
    console.log('Saved solver:', {
      poleCost: run.poleCost,
      lowVoltageCost: run.lowVoltageCost,
      highVoltageCost: run.highVoltageCost,
    });

    // Reset and load core data
    setDataPoints(run.dataPoints || []);
    setMiniGridNodes(run.miniGridNodes || []);
    setMiniGridEdges(
      (run.miniGridEdges || []).map((e: MiniGridEdge) => ({
        start: { lat: Number(e.start?.lat), lng: Number(e.start?.lng) },
        end: { lat: Number(e.end?.lat), lng: Number(e.end?.lng) },
        lengthMeters: Number(e.lengthMeters) || 0,
        voltage: e.voltage || 'low',
      }))
    );

    setPoleCost(Number(run.poleCost) || 100);
    setLowVoltageCost(Number(run.lowVoltageCost) || 10);
    setHighVoltageCost(Number(run.highVoltageCost) || 20);

    // Load cost breakdown if it exists
    setCostBreakdown(run.costBreakdown);

    setSolverOriginalCost(run.costBreakdown?.grandTotal || 0);

    // Restore file name / metadata
    setFileName(run.fileName || null);

    // Optional: recenter map on loaded nodes
    setTimeout(() => {
      if (map && run.miniGridNodes?.length > 0) {
        const bounds = new google.maps.LatLngBounds();
        run.miniGridNodes.forEach((p: MiniGridNode) =>
          bounds.extend({ lat: Number(p.lat), lng: Number(p.lng) })
        );
        map.fitBounds(bounds, { bottom: 80, left: 80, right: 80, top: 80 });
      }
    }, 300);

    alert(`Loaded: ${run.name || 'Mini-grid run'}`);
    setExpandedSections({
      markers: false,
      solver_cost: false,
      export: true,
      savedGrids: false,
    });

    const newState = {
      dataPoints: run.dataPoints || [],
      miniGridNodes: run.miniGridNodes || [],
      miniGridEdges: run.miniGridEdges || [],
      costBreakdown: run.costBreakdown,
    };

    // 1. Update React State
    setDataPoints(newState.dataPoints);
    setMiniGridNodes(newState.miniGridNodes);
    setMiniGridEdges(newState.miniGridEdges);
    setCostBreakdown(newState.costBreakdown);

    // 2. IMPORTANT: If your useMiniGridHistory hook has a 'reset' or 'clear' method,
    // use it here. Otherwise, pushing a new state via saveState()
    // will ALWAYS clear the Redo stack by design.
    saveState(newState);

    alert(`Loaded: ${run.name || 'Mini-grid run'}`);
  };

  const handleDeleteRun = async (runId: string, runName?: string) => {
    if (
      !confirm(
        `Are you sure you want to delete "${runName || 'this mini-grid'}"?`
      )
    ) {
      return;
    }

    try {
      const res = await fetch(`/api/minigrids/${runId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to delete');
      }

      // Remove from local state (optimistic update)
      setSavedRuns((prev) => prev.filter((r) => r.id !== runId));

      alert('Mini-grid deleted successfully');
    } catch (err) {
      console.error('Delete error:', err);
      alert(
        'Failed to delete mini-grid: ' +
          (err instanceof Error ? err.message : 'Unknown error')
      );
    }
  };

  const handleSaveToDatabase = async () => {
    if (!session?.user?.id) {
      alert('Please sign in to save your mini-grid.');
      return;
    }

    if (miniGridNodes.length === 0) {
      alert('No solver results to save yet.');
      return;
    }

    // Quick client-side check (optimistic)
    if (savedRuns.length >= 10) {
      alert(
        'You have reached the maximum of 10 saved mini-grids.\n\n' +
          'Please delete one of your existing runs before saving a new one.'
      );
      return;
    }

    const name =
      prompt('Name for this mini-grid run (optional):') ||
      `MiniGrid ${new Date().toLocaleDateString()}`;

    const payload = {
      name,
      fileName: fileName || null,
      dataPoints,
      miniGridNodes,
      miniGridEdges,
      costBreakdown,
      poleCost,
      lowVoltageCost,
      highVoltageCost,
    };

    try {
      const res = await fetch('/api/minigrids', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to save mini-grid');
      }

      setExpandedSections({
        markers: false,
        solver_cost: false,
        export: false,
        savedGrids: true,
      });

      alert('Mini-grid saved successfully!');

      // ────────────────────────────────────────────────
      // Automatically refresh the saved runs list
      // ────────────────────────────────────────────────
      const refreshRes = await fetch('/api/minigrids');
      if (refreshRes.ok) {
        const updatedRuns = await refreshRes.json();
        setSavedRuns(updatedRuns);
        console.log('Saved runs refreshed:', updatedRuns.length, 'items');
      } else {
        console.warn(
          'Could not refresh saved runs after save',
          refreshRes.status
        );
      }
    } catch (err) {
      console.error('Save error:', err);
      alert(
        'Failed to save mini-grid: ' +
          (err instanceof Error ? err.message : 'Unknown error')
      );
    }
  };

  // For space, I'll note: Paste all remaining functions from your original file here
  // (handleAddManualPoint, handleDragOver, handleDrop, handleResetMap, generateRandomCosts, etc.)

  // ==================== RENDER ====================
  // ==================== RENDER ====================
  return (
    <div className='fixed inset-0 z-50 overflow-hidden bg-zinc-950 text-zinc-900 dark:text-white'>
      {/* MAIN SITE HEADER - Overlay on top of map */}
      <Header />

      {/* 1. Sidebar Toggle Button (Hamburger) */}
      <button
        onClick={() => setSidebarOpen(!sidebarOpen)}
        className='fixed top-20 left-4 z-50 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-600 text-white shadow-xl transition-all hover:scale-110 hover:bg-emerald-500 active:scale-95'
        aria-label='Toggle Sidebar'
      >
        {sidebarOpen ? (
          <svg
            className='h-6 w-6'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={2}
              d='M6 18L18 6'
            />
          </svg>
        ) : (
          <svg
            className='h-6 w-6'
            fill='none'
            stroke='currentColor'
            viewBox='0 0 24 24'
          >
            <path
              strokeLinecap='round'
              strokeLinejoin='round'
              strokeWidth={2}
              d='M4 6h16M4 12h16M4 18h16'
            />
          </svg>
        )}
      </button>

      {/* MAIN CONTAINER - Full Screen Map */}
      <div className='relative h-full overflow-hidden pt-16'>
        {/* FULL-BLEED MAP - Now fills the entire screen */}
        <div ref={mapRef} className='absolute inset-0 bg-zinc-950' />

        {/* Sidebar Drawer */}
        <div
          className={`fixed top-16 left-0 z-40 h-[calc(100vh-4rem)] max-w-full border-r bg-white text-zinc-900 shadow-2xl transition-transform duration-300 ease-in-out dark:bg-zinc-950 dark:text-white ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          style={{ width: `${sidebarWidth}px` }}
        >
          {/* Resize Handle */}
          <div
            className='absolute top-0 right-0 bottom-0 z-50 w-1.5 cursor-col-resize bg-zinc-300 transition-colors hover:bg-purple-500 active:bg-purple-600 dark:bg-zinc-700'
            onMouseDown={handleMouseDown}
          />

          {/* Scrollable Content - Added pt-24 to clear the hamburger menu */}
          <div className='h-full overflow-y-auto p-6 pt-24'>
            <div className='space-y-12'>
              {/* 1. Define Marker Section */}
              <section>
                <button
                  onClick={() => toggleSection('markers')}
                  className='mb-6 flex w-full items-center justify-between rounded-xl bg-emerald-100 px-4 py-3 transition hover:bg-emerald-200 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/40'
                >
                  <h2 className='light:text-emerald-700 text-xl font-bold text-emerald-700 dark:text-emerald-300'>
                    1. Define Markers
                  </h2>
                  <svg
                    className={`h-5 w-5 text-emerald-600 transition-transform dark:text-emerald-400 ${expandedSections.markers ? 'rotate-180' : ''}`}
                    fill='none'
                    stroke='currentColor'
                    viewBox='0 0 24 24'
                  >
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M19 14l-7 7m0 0l-7-7m7 7V3'
                    />
                  </svg>
                </button>

                {expandedSections.markers && (
                  <div className='space-y-4'>
                    {/* Click to Set Marker*/}
                    <div className='rounded-xl border border-zinc-700/70 bg-white p-6 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <ul className='space-y-3 text-sm'>
                        <li className='flex items-start gap-3'>
                          <span className='mt-1 text-emerald-500'>•</span>
                          <span>
                            <strong>Click on the map</strong> to place a marker.
                            Click the <strong>×</strong> button to delete a
                            marker.
                          </span>
                        </li>
                        <li className='flex items-start gap-3'>
                          <span className='mt-1 text-emerald-500'>•</span>
                          <span>
                            <strong>Drag markers</strong> to adjust their
                            placement. Edges cannot exceed{' '}
                            <strong>30 meters</strong>.
                          </span>
                        </li>
                        {/*<li className='flex items-start gap-3'>*/}
                        {/*  <span className='mt-1 text-emerald-500'>•</span>*/}
                        {/*  <span>*/}
                        {/*    <strong>Use the Draw Edge</strong> feature to draw*/}
                        {/*    an edge between markers.*/}
                        {/*  </span>*/}
                        {/*</li>*/}
                        <li className='flex items-start gap-3'>
                          <span className='mt-1 text-emerald-500'>•</span>
                          <span>
                            <strong>Click on an Edge</strong> to delete it.
                          </span>
                        </li>
                      </ul>
                    </div>

                    {/* Generate Test Data Card */}
                    <div className='rounded-xl border border-zinc-700/70 bg-white p-6 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <h3 className='mb-3 text-lg font-semibold text-zinc-100'>
                        Generate Test Data
                      </h3>
                      <p className='mb-4 text-sm leading-snug text-zinc-400'>
                        Random points in ~1 mi² area – good for quick testing
                      </p>

                      <div className='flex flex-wrap items-center gap-4'>
                        <select
                          value={selectedCount}
                          onChange={(e) =>
                            setSelectedCount(Number(e.target.value))
                          }
                          className='min-w-35 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm transition focus:border-emerald-500 focus:ring-2 focus:ring-emerald-500/20'
                          disabled={loading}
                        >
                          {Array.from({ length: 91 }, (_, i) => i + 10).map(
                            (n) => (
                              <option key={n} value={n}>
                                {n} points
                              </option>
                            )
                          )}
                        </select>

                        <button
                          onClick={async () => {
                            if (loading) return;
                            setLoading(true);
                            setDataPoints([]); // ← immediate visual clear
                            setMiniGridNodes([]);
                            setMiniGridEdges([]);
                            setError(null); // clear previous errors

                            try {
                              await generateTestData(selectedCount); // ← make sure this is async if it does any async work
                              console.log(
                                `Generated ${selectedCount} test points successfully`
                              );
                            } catch (err) {
                              const msg =
                                err instanceof Error
                                  ? err.message
                                  : 'Failed to generate test data';
                              setError(msg);
                              console.error(
                                'Test data generation failed:',
                                err
                              );
                            } finally {
                              setLoading(false);
                            }
                          }}
                          disabled={loading}
                          className={`rounded-lg px-6 py-2.5 text-sm font-medium text-zinc-900 transition-all dark:text-white ${
                            loading
                              ? 'cursor-wait bg-blue-700/60'
                              : 'bg-blue-600 shadow-sm hover:bg-blue-700 active:scale-97'
                          } `}
                        >
                          {loading ? (
                            <span className='flex items-center gap-2'>
                              <svg
                                className='h-4 w-4 animate-spin'
                                viewBox='0 0 24 24'
                              >
                                <circle
                                  className='opacity-25'
                                  cx='12'
                                  cy='12'
                                  r='10'
                                  stroke='currentColor'
                                  strokeWidth='4'
                                  fill='none'
                                />
                                <path
                                  className='opacity-75'
                                  fill='currentColor'
                                  d='M4 12a8 8 0 018-8v8h8a8 8 0 01-16 0z'
                                />
                              </svg>
                              Generating…
                            </span>
                          ) : (
                            'Generate'
                          )}
                        </button>
                      </div>
                      {/* Error display (if any) */}
                      {error && (
                        <p className='mt-3 text-center text-sm text-red-400'>
                          {error}
                        </p>
                      )}
                    </div>

                    {/* Upload File*/}
                    <div className='rounded-xl border border-zinc-700/70 bg-white p-6 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <h3 className='mb-3 text-lg font-semibold text-zinc-100'>
                        Upload File
                      </h3>
                      <div className='mb-4 space-y-1.5 text-xs text-zinc-500'>
                        <p>
                          CSV example:{' '}
                          <Dialog>
                            <DialogTrigger asChild>
                              <button className='text-xs text-emerald-400 underline hover:text-emerald-700 dark:text-emerald-300'>
                                Example
                              </button>
                            </DialogTrigger>
                            <DialogContent className='sm:max-w-lg md:max-w-xl lg:max-w-2xl'>
                              <DialogHeader>
                                <DialogTitle>CSV Sample Format</DialogTitle>
                              </DialogHeader>
                              <DialogDescription>
                                <pre className='mt-2 overflow-x-auto rounded bg-zinc-900 p-3 font-mono text-xs whitespace-pre-wrap'>
                                  {`Name,Type,Latitude,Longitude
"Georgia Tech",source,33.77728650,-84.39617097
"Student Center",terminal,33.77680000,-84.39750000
"Library",terminal,33.77420000,-84.39890000
"Dorm A",terminal,33.77850000,-84.39510000
"Cafeteria",terminal,33.77790000,-84.39920000`}
                                </pre>
                                <p className='mt-3 text-xs text-zinc-400'>
                                  • Header row required
                                  <br />
                                  • Type: source or terminal
                                  <br />• ≥6 decimal places recommended
                                </p>
                              </DialogDescription>
                              <DialogFooter>
                                <DialogClose className='rounded bg-emerald-600 px-3 py-1.5 text-xs hover:bg-emerald-700'>
                                  Close
                                </DialogClose>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>{' '}
                          | KML example:{' '}
                          <Dialog>
                            <DialogTrigger asChild>
                              <button className='text-xs text-emerald-400 underline hover:text-emerald-700 dark:text-emerald-300'>
                                Example
                              </button>
                            </DialogTrigger>
                            <DialogContent className='sm:max-w-lg md:max-w-xl lg:max-w-2xl'>
                              {/* your existing KML content here – same as before */}
                              <DialogHeader>
                                <DialogTitle>KML Sample Format</DialogTitle>
                              </DialogHeader>
                              <DialogDescription>
                                <pre className='mt-2 overflow-x-auto rounded bg-zinc-900 p-3 font-mono text-xs whitespace-pre-wrap'>
                                  {`<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <Placemark>
      <name>Georgia Tech</name>
      <description>Type: source</description>
      <Point>
        <coordinates>-84.39617097,33.77728650,0</coordinates>
      </Point>
    </Placemark>
    <Placemark>
      <name>Student Center</name>
      <description>Type: terminal</description>
      <Point>
        <coordinates>-84.39750000,33.77680000,0</coordinates>
      </Point>
    </Placemark>
  </Document>
</kml>`}
                                </pre>
                              </DialogDescription>
                              <DialogFooter>
                                <DialogClose className='rounded bg-emerald-600 px-3 py-1.5 text-xs hover:bg-emerald-700'>
                                  Close
                                </DialogClose>
                              </DialogFooter>
                            </DialogContent>
                          </Dialog>
                        </p>
                      </div>

                      {/* ── Smaller drag & drop area ── */}
                      <div
                        className={`relative rounded-lg border-2 border-dashed p-5 text-center transition-colors ${
                          isDragOver
                            ? 'border-emerald-400 bg-emerald-900/25'
                            : 'border-zinc-700 hover:border-zinc-600'
                        }`}
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                      >
                        <div className='flex flex-wrap items-center justify-center gap-4'>
                          {/* Icon left */}
                          <div className='shrink-0 text-3xl opacity-90'>📄</div>

                          {/* Text + button right */}
                          <div className='flex flex-col items-center gap-2'>
                            <p className='text-base font-medium text-zinc-200'>
                              {isDragOver
                                ? 'Drop file here'
                                : 'Drag & drop or click'}
                            </p>

                            <label className='inline-flex cursor-pointer items-center rounded bg-emerald-600 px-5 py-2.5 text-sm font-medium text-zinc-900 transition hover:bg-emerald-700 active:scale-97 dark:text-white'>
                              Select File
                              <input
                                type='file'
                                accept='.csv,.kml'
                                onChange={handleFileUpload}
                                className='hidden'
                              />
                            </label>
                          </div>
                        </div>
                      </div>

                      {/* Status messages */}
                      <div className='mt-3 text-center text-sm'>
                        <div className='flex flex-wrap items-center justify-center gap-x-6 gap-y-1.5'>
                          {/* Selected file */}
                          {fileName && (
                            <p className='truncate font-medium text-zinc-600 dark:text-zinc-300'>
                              Selected:{' '}
                              <span className='text-zinc-400'>{fileName}</span>
                            </p>
                          )}

                          {/* Loaded count – shown only when successful */}
                          {dataPoints.length > 0 && !loading && (
                            <p className='font-medium text-emerald-700 dark:text-emerald-300'>
                              Loaded {dataPoints.length} point
                              {dataPoints.length !== 1 ? 's' : ''}
                            </p>
                          )}
                        </div>

                        {/* Error or Loading – full width below if present */}
                        {error && (
                          <p className='mt-1.5 text-red-400'>{error}</p>
                        )}

                        {loading && (
                          <p className='mt-1.5 animate-pulse text-emerald-400'>
                            Processing…
                          </p>
                        )}
                      </div>
                    </div>

                    {/* Manual Point Card */}
                    <div className='rounded-xl border border-zinc-700/70 bg-white p-6 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <h3 className='mb-3 text-lg font-semibold text-zinc-100'>
                        Input Coordinates Manually
                      </h3>
                      <form
                        onSubmit={handleAddCoordinatesManually}
                        className='space-y-4'
                      >
                        <div className='grid gap-4 sm:grid-cols-2 lg:grid-cols-4'>
                          <div>
                            <label className='mb-1.5 block text-xs font-medium text-zinc-400'>
                              Name
                            </label>
                            <input
                              type='text'
                              placeholder='e.g. House A'
                              value={manualPoint.name}
                              onChange={(e) =>
                                setManualPoint({
                                  ...manualPoint,
                                  name: e.target.value,
                                })
                              }
                              className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 dark:text-white'
                            />
                          </div>
                          <div>
                            <label className='mb-1.5 block text-xs font-medium text-zinc-400'>
                              Latitude
                            </label>
                            <input
                              type='text'
                              placeholder='33.777...'
                              value={manualPoint.lat}
                              onChange={(e) =>
                                setManualPoint({
                                  ...manualPoint,
                                  lat: e.target.value,
                                })
                              }
                              className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 dark:text-white'
                            />
                          </div>
                          <div>
                            <label className='mb-1.5 block text-xs font-medium text-zinc-400'>
                              Longitude
                            </label>
                            <input
                              type='text'
                              placeholder='-84.396...'
                              value={manualPoint.lng}
                              onChange={(e) =>
                                setManualPoint({
                                  ...manualPoint,
                                  lng: e.target.value,
                                })
                              }
                              className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 dark:text-white'
                            />
                          </div>
                          <div>
                            <label className='mb-1.5 block text-xs font-medium text-zinc-400'>
                              Type
                            </label>
                            <select
                              value={manualPoint.type}
                              onChange={(e) =>
                                setManualPoint({
                                  ...manualPoint,
                                  type: e.target.value as
                                    | 'source'
                                    | 'terminal'
                                    | 'pole',
                                })
                              }
                              className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 dark:text-white'
                            >
                              <option value='terminal'>Terminal</option>
                              <option value='source'>Source</option>
                              <option value='source'>Pole</option>
                            </select>
                          </div>
                        </div>
                        <button
                          type='submit'
                          className='w-full rounded-lg bg-emerald-600 py-2.5 text-sm font-medium text-zinc-900 transition hover:bg-emerald-700 active:scale-95 dark:text-white'
                        >
                          Add Marker to Map
                        </button>
                      </form>
                    </div>
                  </div>
                )}
              </section>

              {/* 2. Costs & Solver Section - (your existing code) */}
              <section>
                <button
                  onClick={() => toggleSection('solver_cost')}
                  className='mb-6 flex w-full items-center justify-between rounded-2xl border border-purple-200 bg-purple-50 px-5 py-4 transition-all hover:bg-purple-100 dark:border-purple-500/30 dark:bg-purple-900/20 dark:hover:bg-purple-900/30'
                >
                  <h2 className='text-xl font-bold text-purple-700 dark:text-purple-300'>
                    2. Costs & Solver
                  </h2>
                  <svg
                    className={`h-5 w-5 text-purple-600 transition-transform dark:text-purple-400 ${expandedSections.solver_cost ? 'rotate-180' : ''}`}
                    fill='none'
                    stroke='currentColor'
                    viewBox='0 0 24 24'
                  >
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M19 14l-7 7m0 0l-7-7m7 7V3'
                    />
                  </svg>
                </button>

                {expandedSections.solver_cost && (
                  <div className='space-y-4'>
                    <div className='flex flex-col rounded-xl border border-zinc-700/70 bg-white p-7 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <h3 className='light:text-zinc-300 mb-5 text-xl font-semibold dark:text-zinc-100'>
                        Cost Parameters
                      </h3>
                      <div className='grid gap-6 sm:grid-cols-3'>
                        <div>
                          <label className='light:text-zinc-100 mb-2 block text-sm font-medium dark:text-zinc-300'>
                            Pole ($)
                          </label>
                          <input
                            type='number'
                            step='0.01'
                            min='0'
                            value={poleCost}
                            onChange={(e) =>
                              setPoleCost(parseFloat(e.target.value))
                            }
                            className='light:bg-zinc-100 w-full rounded-lg border border-zinc-700 px-4 py-2.5 text-sm focus:border-emerald-500 dark:bg-zinc-800'
                          />
                        </div>
                        <div>
                          <label className='mb-2 block text-sm font-medium text-zinc-600 dark:text-zinc-300'>
                            Low Volt. ($/m)
                          </label>
                          <input
                            type='number'
                            step='0.01'
                            min='0'
                            value={lowVoltageCost}
                            onChange={(e) =>
                              setLowVoltageCost(parseFloat(e.target.value))
                            }
                            className='light:bg-zinc-100 w-full rounded-lg border border-zinc-700 px-4 py-2.5 text-sm focus:border-emerald-500 dark:bg-zinc-800'
                          />
                        </div>
                        <div>
                          <label className='mb-2 block text-sm font-medium text-zinc-600 dark:text-zinc-300'>
                            High Volt. ($/m)
                          </label>
                          <input
                            type='number'
                            step='0.01'
                            min='0'
                            value={highVoltageCost}
                            onChange={(e) =>
                              setHighVoltageCost(parseFloat(e.target.value))
                            }
                            disabled
                            className='light:bg-zinc-100 w-full rounded-lg border border-zinc-700 px-4 py-2.5 text-sm focus:border-emerald-500 dark:bg-zinc-800'
                          />
                        </div>
                      </div>
                      <button
                        onClick={generateRandomCosts}
                        className='mt-5 text-sm text-emerald-400 hover:underline'
                      >
                        Use realistic random values
                      </button>
                    </div>

                    {/* Solver Selection + Parameters + Run */}
                    <div className='flex flex-col rounded-xl border border-zinc-700/70 bg-white p-7 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <h3 className='light:text-zinc-300 mb-5 text-xl font-semibold dark:text-zinc-100'>
                        Solver Configuration
                      </h3>

                      {/* Solver Select */}
                      <div className='relative mb-6'>
                        <label
                          htmlFor='solver-select'
                          className='light:text-zinc-600 mb-2 block text-sm font-medium dark:text-zinc-300'
                        >
                          Select Solver
                        </label>
                        <select
                          id='solver-select'
                          value={selectedSolverName}
                          onChange={(e) =>
                            setSelectedSolverName(e.target.value)
                          }
                          className='light:bg-zinc-600/70dark:bg-zinc-800/70 light:text-zinc-400 w-full appearance-none rounded-lg border border-zinc-700/70 px-4 py-3 pr-10 text-base font-medium focus:border-purple-500/60 focus:ring-2 focus:ring-purple-500/40 dark:text-zinc-100'
                        >
                          <option value='' disabled>
                            Choose a solver...
                          </option>
                          {solvers.map((s) => (
                            <option key={s.name} value={s.name}>
                              {s.name}
                            </option>
                          ))}
                        </select>
                        <div className='pointer-events-none absolute inset-y-13 right-0 flex items-center pr-4'>
                          <svg
                            className='h-5 w-5 text-zinc-400 dark:text-zinc-500'
                            fill='none'
                            stroke='currentColor'
                            viewBox='0 0 24 24'
                          >
                            <path
                              strokeLinecap='round'
                              strokeLinejoin='round'
                              strokeWidth={2}
                              d='M19 9l-7 7-7-7'
                            />
                          </svg>
                        </div>
                      </div>

                      {/* Dynamic Solver Parameters */}
                      {selectedSolver && selectedSolver.params?.length > 0 && (
                        <div className='mb-6 space-y-5 rounded-lg border border-zinc-700/50 bg-zinc-900/40 p-5'>
                          <h4 className='text-lg font-medium text-zinc-200'>
                            {selectedSolver.name} Parameters
                          </h4>
                          <div className='grid gap-5 sm:grid-cols-2'>
                            {selectedSolver.params.map((param) => (
                              <div key={param.name} className='space-y-1.5'>
                                <label
                                  htmlFor={`param-${param.name}`}
                                  className='block text-sm font-medium text-zinc-600 dark:text-zinc-300'
                                >
                                  {param.name}
                                  <span className='ml-2 text-xs text-zinc-500'>
                                    (default: {param.default})
                                  </span>
                                </label>
                                <input
                                  id={`param-${param.name}`}
                                  type='number'
                                  min={param.min}
                                  max={param.max}
                                  step={param.type === 'integer' ? 1 : 0.01}
                                  value={paramValues[param.name] ?? ''}
                                  onChange={(e) =>
                                    updateParam(param.name, e.target.value)
                                  }
                                  className='w-full rounded-md border border-zinc-700 bg-zinc-800/70 px-3 py-2 text-zinc-100 focus:border-purple-500/60 focus:ring-2 focus:ring-purple-500/30'
                                />
                                {param.description && (
                                  <p className='text-xs text-zinc-500'>
                                    {param.description}
                                  </p>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {hasPoles && (
                        <div className='light:bg-zinc-400/40 light:border-zinc-700/50 mt-4 flex items-center gap-3 rounded-lg border p-4 dark:border-zinc-700/50 dark:bg-zinc-900/40'>
                          <input
                            type='checkbox'
                            id='use-poles'
                            checked={useExistingPoles}
                            onChange={(e) =>
                              setUseExistingPoles(e.target.checked)
                            }
                            className='light:bg-zinc-300 h-5 w-5 rounded border-zinc-600 text-purple-600 focus:ring-purple-500 dark:bg-zinc-800'
                          />
                          <label
                            htmlFor='use-poles'
                            className='light:text-zinc-600 cursor-pointer text-sm font-medium dark:text-zinc-300'
                          >
                            Use existing poles in calculation ({poleCount} poles
                            detected)
                          </label>
                        </div>
                      )}

                      {/* Run Button */}
                      <div className='mt-auto pt-4'>
                        <button
                          onClick={handleRunSolver}
                          disabled={
                            computingMiniGrid ||
                            dataPoints.length < 2 ||
                            !selectedSolverName
                          }
                          className='w-full rounded-xl bg-linear-to-r from-purple-600 to-indigo-600 px-8 py-5 text-lg font-bold shadow-xl shadow-purple-900/40 transition-all hover:scale-[1.02] hover:from-purple-500 hover:to-indigo-500 disabled:opacity-50'
                        >
                          {computingMiniGrid ? 'Solving...' : 'Run Solver'}
                        </button>

                        <p className='mt-4 text-xs text-zinc-500'>
                          Beta • Low Voltage Only • Limited to Single Power
                          Source
                        </p>
                      </div>

                      {calcError && (
                        <p className='mt-4 text-center text-sm font-medium text-red-400'>
                          {calcError}
                        </p>
                      )}

                      {calculationResult && (
                        <div className='mt-6 w-full rounded-lg border border-zinc-800 bg-zinc-950/60 p-4 text-left'>
                          <h4 className='mb-2 text-sm font-semibold text-emerald-700 dark:text-emerald-300'>
                            Python result:
                          </h4>
                          <pre className='overflow-x-auto text-xs text-emerald-200/90'>
                            {calculationResult}
                          </pre>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </section>

              {/* 3. Export & Summary Section */}
              <section>
                <button
                  onClick={() => toggleSection('export')}
                  className='mb-6 flex w-full items-center justify-between rounded-2xl border border-blue-500/30 bg-blue-900/20 px-5 py-4 transition-all hover:bg-blue-900/30'
                >
                  <h2 className='text-xl font-bold text-blue-700 dark:text-blue-300'>
                    3. Export & Summary
                  </h2>
                  <svg
                    className={`h-5 w-5 text-blue-400 transition-transform ${
                      expandedSections.export ? 'rotate-180' : ''
                    }`}
                    fill='none'
                    stroke='currentColor'
                    viewBox='0 0 24 24'
                  >
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M19 14l-7 7m0 0l-7-7m7 7V3'
                    />
                  </svg>
                </button>

                {expandedSections.export && (
                  <div className='space-y-4'>
                    {miniGridNodes.length > 0 && (
                      <div className='light:bg-zinc-400/40 light:border-zinc-700/50 mt-4 flex items-center gap-3 rounded-lg border p-4 dark:border-zinc-700/50 dark:bg-zinc-900/40'>
                        <input
                          type='checkbox'
                          id='allow-drag-terminals'
                          checked={allowDragTerminals}
                          onChange={(e) =>
                            setAllowDragTerminals(e.target.checked)
                          }
                          className='h-5 w-5 rounded border-zinc-600 bg-zinc-800 text-purple-600 focus:ring-purple-500'
                        />
                        <label
                          htmlFor='allow-drag-terminals'
                          className='cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-300'
                        >
                          Allow dragging of{' '}
                          <span className='font-semibold text-blue-400'>
                            Terminals
                          </span>{' '}
                          (Poles can always be dragged)
                        </label>
                      </div>
                    )}

                    {/* Solver Cost Box */}
                    {solverOriginalCost > 0 && (
                      <div className='rounded-2xl border border-purple-500/30 bg-purple-900/20 p-6 text-center'>
                        <p className='text-xs font-bold tracking-widest text-purple-400 uppercase'>
                          Solver Cost
                        </p>
                        <p className='mt-1 text-4xl font-extrabold text-purple-300'>
                          ${formatUSD(solverOriginalCost)}
                        </p>
                        <div className='mt-4 grid grid-cols-2 gap-x-4 border-t border-purple-500/20 pt-4 text-left text-[10px] text-purple-300/70'>
                          {/* Column 1: Poles */}
                          <div className='space-y-1'>
                            <p className='text-xs font-semibold text-purple-400'>
                              Poles
                            </p>
                            <p>
                              {costBreakdown.poleCount} @ $
                              {formatUSD(
                                costBreakdown.usedPoleCost || poleCost
                              )}
                            </p>
                            <p className='pt-1 font-medium text-purple-200'>
                              Total: ${formatUSD(costBreakdown.poleCost)}
                            </p>
                          </div>
                          {/* Column 2: Wires (Separated) */}
                          <div className='space-y-3 border-l border-purple-500/10 pl-4'>
                            <div className='space-y-0.5'>
                              <p className='text-xs font-semibold text-purple-400'>
                                LV Wire
                              </p>
                              <p>
                                {formatMeters(costBreakdown.lowVoltageMeters)}m
                                @ $
                                {formatUSD(
                                  costBreakdown.usedLowCostPerMeter ||
                                    lowVoltageCost
                                )}
                                /m
                              </p>
                              <p className='font-medium text-purple-200'>
                                Total: ${formatUSD(costBreakdown.lowWireCost)}
                              </p>
                            </div>
                            <div className='space-y-0.5'>
                              <p className='text-xs font-semibold text-purple-400'>
                                HV Wire
                              </p>
                              <p>
                                {formatMeters(costBreakdown.highVoltageMeters)}m
                                @ $
                                {formatUSD(
                                  costBreakdown.usedHighCostPerMeter ||
                                    highVoltageCost
                                )}
                                /m
                              </p>
                              <p className='font-medium text-purple-200'>
                                Total: ${formatUSD(costBreakdown.highWireCost)}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Live Cost Box */}
                    {costBreakdown.grandTotal > 0 && (
                      <div className='rounded-2xl border border-emerald-500/30 bg-emerald-900/20 p-6 text-center'>
                        <p className='text-xs font-bold tracking-widest text-emerald-400 uppercase'>
                          Live Cost
                        </p>
                        <p className='mt-1 text-4xl font-extrabold text-emerald-700 dark:text-emerald-300'>
                          ${formatUSD(costBreakdown.grandTotal)}
                        </p>
                        <div className='mt-4 grid grid-cols-2 gap-x-4 border-t border-emerald-500/20 pt-4 text-left text-[10px] text-emerald-400/70'>
                          {/* Column 1: Poles */}
                          <div className='space-y-1'>
                            <p className='text-xs font-semibold text-emerald-500'>
                              Poles
                            </p>
                            <p>
                              {
                                miniGridNodes.filter((n) => n.type === 'pole')
                                  .length
                              }{' '}
                              @ ${formatUSD(poleCost)}
                            </p>
                            <p className='pt-1 font-medium text-emerald-200'>
                              Total: $
                              {formatUSD(
                                miniGridNodes.filter((n) => n.type === 'pole')
                                  .length * poleCost
                              )}
                            </p>
                          </div>
                          {/* Column 2: Wires (Separated) */}
                          <div className='space-y-3 border-l border-emerald-500/10 pl-4'>
                            <div className='space-y-0.5'>
                              <p className='text-xs font-semibold text-emerald-500'>
                                LV Wire
                              </p>
                              <p>
                                {formatMeters(costBreakdown.lowVoltageMeters)}m
                                @ ${formatUSD(lowVoltageCost)}/m
                              </p>
                              <p className='font-medium text-emerald-200'>
                                Total: $
                                {formatUSD(
                                  costBreakdown.lowVoltageMeters *
                                    lowVoltageCost
                                )}
                              </p>
                            </div>
                            <div className='space-y-0.5'>
                              <p className='text-xs font-semibold text-emerald-500'>
                                HV Wire
                              </p>
                              <p>
                                {formatMeters(costBreakdown.highVoltageMeters)}m
                                @ ${formatUSD(highVoltageCost)}/m
                              </p>
                              <p className='font-medium text-emerald-200'>
                                Total: $
                                {formatUSD(
                                  costBreakdown.highVoltageMeters *
                                    highVoltageCost
                                )}
                              </p>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Cost Difference Box */}
                    {costBreakdown.grandTotal !== 0 &&
                      solverOriginalCost > 0 && (
                        <div
                          className={`rounded-2xl border p-6 text-center ${
                            isNegative
                              ? 'border-emerald-500/30 bg-emerald-900/20'
                              : 'border-red-500/30 bg-red-900/20'
                          }`}
                        >
                          <p
                            className={`text-xs font-bold tracking-widest uppercase ${
                              isNegative ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            Cost Difference
                          </p>
                          <p
                            className={`mt-1 text-4xl font-extrabold ${
                              isNegative
                                ? 'text-emerald-700 dark:text-emerald-300'
                                : 'text-red-300'
                            }`}
                          >
                            ${formatUSD(costDiff)}
                          </p>
                          <p className='mt-2 text-[10px] italic opacity-60'>
                            {isNegative
                              ? 'Savings vs Solver baseline'
                              : 'Additional cost vs Solver baseline'}
                          </p>
                        </div>
                      )}

                    {miniGridNodes.length > 0 && (
                      <div className='pt-4'>
                        <h3 className='mb-4 text-xl font-semibold text-emerald-700 dark:text-emerald-300'>
                          Export Options
                        </h3>
                        <div className='flex flex-col gap-3'>
                          <button
                            onClick={downloadKml}
                            disabled={
                              miniGridNodes.length === 0 ||
                              miniGridEdges.length === 0
                            }
                            className='w-full rounded-xl bg-purple-600 py-4 font-semibold text-zinc-900 hover:bg-purple-700 disabled:opacity-50 dark:text-white'
                          >
                            📥 Download KML
                          </button>

                          <SaveMiniGridButton
                            isAuthenticated={!!session?.user}
                            onSave={handleSaveToDatabase}
                            disabled={
                              computingMiniGrid ||
                              miniGridNodes.length === 0 ||
                              savedRuns.length >= 10
                            }
                          />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </section>

              {/* 4. Saved Mini-grids */}
              <section>
                <button
                  onClick={() => toggleSection('savedGrids')}
                  className='mb-6 flex w-full items-center justify-between rounded-xl bg-emerald-100 px-4 py-3 transition hover:bg-emerald-200 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/40'
                >
                  <h2 className='light:text-emerald-700 text-lg font-bold text-emerald-700 dark:text-emerald-300'>
                    Saved Mini-grids ({savedRuns.length}/10)
                  </h2>
                  <svg
                    className={`h-5 w-5 text-emerald-600 transition-transform dark:text-emerald-400 ${expandedSections.savedGrids ? 'rotate-180' : ''}`}
                    fill='none'
                    stroke='currentColor'
                    viewBox='0 0 24 24'
                  >
                    <path
                      strokeLinecap='round'
                      strokeLinejoin='round'
                      strokeWidth={2}
                      d='M19 14l-7 7m0 0l-7-7m7 7V3'
                    />
                  </svg>
                </button>

                {expandedSections.savedGrids && (
                  <div className='space-y-4'>
                    {/* Saved Runs (conditional) */}
                    {session?.user && (
                      <div className='rounded-xl border border-zinc-700/70 bg-white p-6 backdrop-blur-sm lg:col-span-9 xl:col-span-3 dark:bg-zinc-900/50'>
                        {loadingSaved ? (
                          <p className='py-4 text-sm text-emerald-400'>
                            Loading…
                          </p>
                        ) : savedRuns.length === 0 ? (
                          <p className='py-4 text-sm text-zinc-500 italic'>
                            No saved runs yet
                          </p>
                        ) : (
                          <div className='scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-zinc-900/50 -mr-2 max-h-73 overflow-y-auto pr-2'>
                            <div className='grid gap-4 sm:grid-cols-1 md:grid-cols-1 lg:grid-cols-1'>
                              {savedRuns.map((run) => (
                                <div
                                  key={run.id}
                                  className='group relative cursor-pointer rounded-lg border border-zinc-800/60 bg-zinc-950/40 p-4 transition-all hover:border-emerald-700/50 hover:bg-zinc-900/60'
                                  onClick={() => loadSavedRun(run)}
                                >
                                  <button
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      handleDeleteRun(run.id, run.name);
                                    }}
                                    className='absolute top-2 right-2 rounded-full bg-red-900/60 p-1.5 text-red-300 opacity-70 transition hover:opacity-100'
                                    title='Delete run'
                                  >
                                    <svg
                                      className='h-4 w-4'
                                      fill='none'
                                      stroke='currentColor'
                                      viewBox='0 0 24 24'
                                    >
                                      <path
                                        strokeLinecap='round'
                                        strokeLinejoin='round'
                                        strokeWidth={2}
                                        d='M6 18L18 6M6 6l12 12'
                                      />
                                    </svg>
                                  </button>

                                  <h4 className='truncate font-medium text-emerald-700 group-hover:text-emerald-200 dark:text-emerald-300/90'>
                                    {run.name || 'Untitled'}
                                  </h4>
                                  <p className='mt-1 text-xs text-zinc-500'>
                                    {run.fileName
                                      ? `File: ${run.fileName}`
                                      : 'Test data'}
                                  </p>
                                  <p className='mt-0.5 text-xs text-zinc-600'>
                                    {new Date(run.createdAt).toLocaleString()}
                                    <br />
                                    {run.miniGridNodes?.length || '?'} nodes |{' '}
                                    <span className='font-medium text-green-600'>
                                      {new Intl.NumberFormat('en-US', {
                                        style: 'currency',
                                        currency: 'USD',
                                      }).format(run.costBreakdown.grandTotal)}
                                    </span>
                                  </p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </section>
            </div>
            <br />
            <hr />
            <br />
            <p className='text-center text-xs text-zinc-500 dark:text-zinc-400'>
              <a href={'https://forms.gle/Az6j5cjtzJJDEQAEA'} target='_blank'>
                Give Feedback
              </a>
            </p>
          </div>
        </div>

        {/* Floating Action Buttons - Horizontal Row */}
        <div className='fixed right-40 bottom-5 z-50 flex items-center gap-3'>
          {/* DRAW EDGE BUTTON - Now floating! */}
          {/*<button*/}
          {/*  onClick={() => {*/}
          {/*    setIsDrawingMode((prev) => {*/}
          {/*      const newMode = !prev;*/}
          {/*      if (!newMode) setFirstSelectedPoint(null);*/}
          {/*      return newMode;*/}
          {/*    });*/}
          {/*  }}*/}
          {/*  className={`flex items-center gap-2 rounded-full px-6 py-3 text-sm font-medium shadow-2xl transition-all active:scale-95 ${*/}
          {/*    isDrawingMode*/}
          {/*      ? 'bg-purple-600 text-white ring-2 ring-purple-400/50'*/}
          {/*      : 'bg-zinc-700 text-white hover:bg-zinc-600'*/}
          {/*  }`}*/}
          {/*  title={*/}
          {/*    isDrawingMode*/}
          {/*      ? 'Exit drawing mode'*/}
          {/*      : 'Draw new edge between 2 markers'*/}
          {/*  }*/}
          {/*>*/}
          {/*  <svg*/}
          {/*    xmlns='http://www.w3.org/2000/svg'*/}
          {/*    className='h-5 w-5'*/}
          {/*    fill='none'*/}
          {/*    viewBox='0 0 24 24'*/}
          {/*    stroke='currentColor'*/}
          {/*    strokeWidth={2.5}*/}
          {/*  >*/}
          {/*    <path*/}
          {/*      strokeLinecap='round'*/}
          {/*      strokeLinejoin='round'*/}
          {/*      d='M15 12a3 3 0 11-6 0 3 3 0 016 0z'*/}
          {/*    />*/}
          {/*    <path*/}
          {/*      strokeLinecap='round'*/}
          {/*      strokeLinejoin='round'*/}
          {/*      d='M17 8l-4 4-4-4'*/}
          {/*    />*/}
          {/*    <path*/}
          {/*      strokeLinecap='round'*/}
          {/*      strokeLinejoin='round'*/}
          {/*      d='M3 8l4 4 4-4'*/}
          {/*    />*/}
          {/*  </svg>*/}
          {/*  {isDrawingMode ? 'Drawing Mode' : 'Draw Edge'}*/}
          {/*</button>*/}

          {/* Undo Button (unchanged) */}
          <button
            onClick={() => {
              const s = undo();
              if (s) {
                setDataPoints(s.dataPoints);
                setMiniGridNodes(s.miniGridNodes);
                setMiniGridEdges(s.miniGridEdges);
                setCostBreakdown(s.costBreakdown);
              }
            }}
            disabled={!canUndo}
            className='flex items-center gap-2 rounded-full bg-amber-600/90 px-5 py-3 text-sm font-medium text-white shadow-2xl transition-all hover:bg-amber-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50'
            title='Undo (Ctrl/Cmd + Z)'
          >
            <svg
              xmlns='http://www.w3.org/2000/svg'
              className='h-4 w-4'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
              strokeWidth={2.5}
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M3 10h10a8 8 0 018 8v2M3 10l6 6 6-6'
              />
            </svg>
            Undo
          </button>

          {/* Redo Button (unchanged) */}
          <button
            onClick={() => {
              const s = redo();
              if (s) {
                setDataPoints(s.dataPoints);
                setMiniGridNodes(s.miniGridNodes);
                setMiniGridEdges(s.miniGridEdges);
                setCostBreakdown(s.costBreakdown);
              }
            }}
            disabled={!canRedo}
            className='flex items-center gap-2 rounded-full bg-amber-600/90 px-5 py-3 text-sm font-medium text-white shadow-2xl transition-all hover:bg-amber-600 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50'
            title='Redo (Ctrl/Cmd + Shift + Z)'
          >
            <svg
              xmlns='http://www.w3.org/2000/svg'
              className='h-4 w-4'
              fill='none'
              viewBox='0 0 24 24'
              stroke='currentColor'
              strokeWidth={2.5}
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M21 10h-10a8 8 0 00-8 8v2m18-10l-6 6-6-6'
              />
            </svg>
            Redo
          </button>

          {/* Reset Button (unchanged) */}
          <button
            onClick={handleResetMap}
            disabled={dataPoints.length === 0 && miniGridNodes.length === 0}
            className='flex items-center gap-2 rounded-full bg-red-600/90 px-6 py-3 text-sm font-medium text-zinc-900 shadow-2xl transition-all hover:bg-red-600 active:scale-95 disabled:opacity-50 dark:text-white'
            title='Reset everything'
          >
            <svg
              xmlns='http://www.w3.org/2000/svg'
              className='h-4 w-4'
              fill='none'
              stroke='currentColor'
              viewBox='0 0 24 24'
              strokeWidth={2.5}
            >
              <path
                strokeLinecap='round'
                strokeLinejoin='round'
                d='M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15'
              />
            </svg>
            Reset
          </button>
        </div>

        {/* FOOTER - Minimal */}
        <footer className='border-t border-zinc-800 bg-zinc-950 py-4 text-center text-xs text-zinc-600'>
          © 2026 • CS 6150 Computing For Good • Renewvia Project Demo
        </footer>

        <Script
          src={`https://maps.googleapis.com/maps/api/js?key=${GOOGLE_MAPS_API_KEY}&libraries=marker`}
          strategy='afterInteractive'
          onLoad={initMap}
        />
      </div>
      {/* Dialog for adding a point via map click */}
      <Dialog
        open={isAddPointDialogOpen}
        onOpenChange={setIsAddPointDialogOpen}
      >
        <DialogContent className='border-zinc-800 bg-zinc-900 text-white sm:max-w-[425px]'>
          <DialogHeader>
            <DialogTitle>Add New Point</DialogTitle>
            <DialogDescription className='text-zinc-400'>
              Set the details for the location you just clicked.
            </DialogDescription>
          </DialogHeader>
          <div className='grid gap-4 py-4'>
            <div className='grid grid-cols-4 items-center gap-4'>
              <label className='text-right text-sm'>Name</label>
              <input
                value={newPointDetails.name}
                onChange={(e) =>
                  setNewPointDetails({
                    ...newPointDetails,
                    name: e.target.value,
                  })
                }
                className='col-span-3 rounded-md border-zinc-700 bg-zinc-800 px-3 py-2 text-sm'
              />
            </div>
            <div className='grid grid-cols-4 items-center gap-4'>
              <label className='text-right text-sm'>Type</label>
              <select
                value={newPointDetails.type}
                onChange={(e) =>
                  setNewPointDetails({
                    ...newPointDetails,
                    type: e.target.value as 'source' | 'terminal' | 'pole',
                  })
                }
                className='col-span-3 rounded-md border-zinc-700 bg-zinc-800 px-3 py-2 text-sm'
              >
                <option value='terminal'>Terminal</option>
                <option value='source'>Source</option>
                <option value='pole'>Pole</option>
              </select>
            </div>
          </div>
          <DialogFooter>
            <button
              onClick={() => setIsAddPointDialogOpen(false)}
              className='px-4 py-2 text-sm text-zinc-400 hover:text-white'
            >
              Cancel
            </button>
            <button
              onClick={handleConfirmNewPoint}
              className='rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium hover:bg-emerald-700'
            >
              Add Point
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Save Button Component
function SaveMiniGridButton({
  isAuthenticated,
  onSave,
  disabled,
}: {
  isAuthenticated: boolean;
  onSave: () => void;
  disabled: boolean;
}) {
  if (!isAuthenticated) {
    return (
      <button
        disabled
        className='w-full cursor-not-allowed rounded-xl bg-zinc-700 py-4 text-zinc-400'
      >
        Sign in to Save
      </button>
    );
  }
  return (
    <button
      onClick={onSave}
      disabled={disabled}
      className='w-full rounded-xl bg-emerald-600 py-4 font-semibold text-zinc-900 hover:bg-emerald-700 disabled:opacity-50 dark:text-white'
    >
      💾 Save to My Mini-Grids
    </button>
  );
}
