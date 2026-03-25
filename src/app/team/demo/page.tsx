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
interface LocationPoint {
  name: string;
  type: 'source' | 'terminal' | 'pole';
  lat: number;
  lng: number;
}

interface MiniGridEdge {
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  lengthMeters: number;
  voltage: 'low' | 'high';
}

interface MiniGridNode {
  index: number;
  lat: number;
  lng: number;
  name: string;
  type: 'source' | 'terminal' | 'pole';
}

interface CostBreakdown {
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
  dataPoints: LocationPoint[];
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

  const [dataPoints, setDataPoints] = useState<LocationPoint[]>([]);
  const [miniGridEdges, setMiniGridEdges] = useState<MiniGridEdge[]>([]);
  const [miniGridNodes, setMiniGridNodes] = useState<MiniGridNode[]>([]);
  const [originalDataPoints, setOriginalDataPoints] = useState<LocationPoint[]>(
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
  const [allowDragTerminals, setAllowDragTerminals] = useState(false);
  const [expandedSections, setExpandedSections] = useState<
    Record<string, boolean>
  >({
    locations: false,
    costs: false,
    export: false,
  });

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const [solvers, setSolvers] = useState<Solvers[]>([]);
  const [selectedSolverName, setSelectedSolverName] = useState<string>(
    'GreedyNSteinerSolver'
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
    type: 'terminal' as 'source' | 'terminal',
  });

  const [savedRuns, setSavedRuns] = useState<MiniGridRun[]>([]);
  const [loadingSaved, setLoadingSaved] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const { data: session } = useSession();

  // ==================== MAP INITIALIZATION ====================
  const initMap = () => {
    if (!window.google?.maps || !mapRef.current) return;

    const googleMap = new window.google.maps.Map(mapRef.current, {
      center: { lat: 39.8283, lng: -98.5795 },
      zoom: 4,
      mapTypeId: 'satellite' as google.maps.MapTypeId,
      fullscreenControl: false,
      streetViewControl: false,
      mapId: 'DEMO_MAP_ID',
    });

    setMap(googleMap);
  };

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

      const iconImg = document.createElement('img');
      iconImg.src = iconUrl;
      iconImg.style.width = `${scaledSize.width}px`;
      iconImg.style.height = `${scaledSize.height}px`;
      content.appendChild(iconImg);

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
        if (!isPole && !allowDragTerminals) {
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

        // 4. UPDATE VISUALS: If rules are passed, move the lines and update costs
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
      // 5. Enforce final snap back when the user lets go of the mouse
      marker.addListener('dragend', () => {
        let finalLat = point.lat; // default to original pre-drag location
        let finalLng = point.lng;

        const prevStr = markerDragRef.current;
        if (prevStr) {
          // Snap the visual marker to the last valid position
          const [prevLat, prevLng] = prevStr.split(',').map(Number);
          marker.position = { lat: prevLat, lng: prevLng };
          finalLat = prevLat;
          finalLng = prevLng;
        }

        // 6. SYNC REACT STATE: Ensure exports and saves use the new coordinates

        // Update Nodes array
        setMiniGridNodes((prev) =>
          prev.map((n) =>
            n.name === point.name ? { ...n, lat: finalLat, lng: finalLng } : n
          )
        );

        // Update Input Points array
        setDataPoints((prev) =>
          prev.map((p) =>
            p.name === point.name ? { ...p, lat: finalLat, lng: finalLng } : p
          )
        );

        // Update Edges array (so the new line lengths and connections are saved)
        setMiniGridEdges((prev) =>
          prev.map((edge) => {
            // Identify if the dragged point was the start or end of this edge
            // using the original pre-drag coordinates stored in the `point` closure
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
              const newEnd = isEnd
                ? { lat: finalLat, lng: finalLng }
                : edge.end;

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
          })
        );

        markerDragRef.current = null;
      });

      return marker;
    },
    [allowDragTerminals, lowVoltageCost, highVoltageCost, poleCount]
  );

  const [sidebarWidth, setSidebarWidth] = useState(420); // default width

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

  useEffect(() => {
    if (isResizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    }
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isResizing]);
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
      polylinesRef.current.push(polyline);
    });
  }, [map, miniGridEdges]);

  // ==================== FILE HANDLING, SOLVER, etc. ====================
  // Copy all your existing functions here:
  // handleFileUpload, processFile, parseKml, generateTestData, handleRunSolver,
  // downloadKml, loadSavedRun, handleSaveToDatabase, handleDeleteRun, etc.
  // Fetch saved runs when user is logged in
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

  useEffect(() => {
    if (!map) return;

    // 1. Clear everything first
    markersRef.current.forEach((marker) => {
      marker.map = null;
    });
    markersRef.current = [];

    // 2. Decide which points to show (Solver result takes priority)
    const pointsToShow = miniGridNodes.length > 0 ? miniGridNodes : dataPoints;

    if (pointsToShow.length === 0) return;

    const bounds = new google.maps.LatLngBounds();
    let hasValidPoints = false;

    // 3. Create markers
    pointsToShow.forEach((point) => {
      if (isNaN(point.lat) || isNaN(point.lng)) return;

      hasValidPoints = true;

      const marker = createMarker(
        {
          lat: point.lat,
          lng: point.lng,
          name: point.name,
          type: 'type' in point ? point.type : undefined,
        },
        map
      );

      markersRef.current.push(marker);
      bounds.extend({ lat: point.lat, lng: point.lng });
    });

    // 4. Fit bounds only if we actually added something
    if (hasValidPoints && !bounds.isEmpty()) {
      // Small delay helps when map is still settling / resizing
      setTimeout(() => {
        map.fitBounds(bounds, { bottom: 80, left: 80, right: 80, top: 80 });
      }, 150);
    }
  }, [map, dataPoints, miniGridNodes]);

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

  const handleAddManualPoint = (e: React.FormEvent) => {
    e.preventDefault();
    const lat = parseFloat(manualPoint.lat);
    const lng = parseFloat(manualPoint.lng);

    if (isNaN(lat) || isNaN(lng)) {
      alert('Please enter valid latitude and longitude numbers.');
      return;
    }

    const newPoint: LocationPoint = {
      name: manualPoint.name || `Manual Point ${dataPoints.length + 1}`,
      type: manualPoint.type,
      lat: lat,
      lng: lng,
    };

    setDataPoints((prev) => [...prev, newPoint]);

    // Reset form
    setManualPoint({ name: '', lat: '', lng: '', type: 'terminal' });
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

    console.log('Parsed KML:', { nodes, edges, costBreakdown });

    return { nodes, edges, costBreakdown };
  };

  const handleFileUpload = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow uploading the same file name again
    if (!file) return;

    processFile(file);
  };

  const processFile = (file: File) => {
    setMiniGridEdges([]);
    setOriginalDataPoints([]);
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

          console.log('Parsed KML:', parsed);

          if (parsed.nodes.length === 0 && parsed.edges.length === 0) {
            setError('No valid data found in the KML file.');
            setDataPoints([]);
            setOriginalDataPoints([]);
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
          } else {
            // Filter valid nodes (exclude any placeholder/summary nodes)
            const validNodes = parsed.nodes
              .filter((n) => !isNaN(n.lat) && !isNaN(n.lng))
              .map((n, idx) => ({
                ...n,
                index: n.index >= 0 ? n.index : idx, // fallback to array position if -1
              }));

            console.log('Valid nodes:', validNodes);

            // Full solved state: show all nodes (including poles) and edges
            setMiniGridNodes(validNodes);
            setMiniGridEdges(parsed.edges);

            // Original input points = only source + terminal (no poles)
            const originalPoints: LocationPoint[] = validNodes
              .filter((n) => n.type !== 'pole')
              .map((n) => ({
                name: n.name,
                type: n.type,
                lat: n.lat,
                lng: n.lng,
              }));

            setDataPoints(originalPoints);
            setOriginalDataPoints(originalPoints);

            console.log('After KML load ────────────────────────────────');
            console.log('miniGridNodes:', miniGridNodes); // should have poles + sources/terminals
            console.log('miniGridEdges:', miniGridEdges); // should have voltage + lengthMeters
            console.log('dataPoints:', dataPoints); // should have only source + terminals
            console.log('costBreakdown:', costBreakdown);
            console.log('selectedSolverName still:', selectedSolverName);

            // Restore costs if present
            if (parsed.costBreakdown) {
              setCostBreakdown(parsed.costBreakdown);

              // Back-calculate per-unit costs (with fallback defaults)
              const cb = parsed.costBreakdown;

              setPoleCost(
                cb.usedPoleCost ||
                  cb.poleCost / Math.max(cb.poleCount, 1) ||
                  100
              );

              const lowM = cb.lowVoltageMeters || 0;
              setLowVoltageCost(lowM > 0 ? cb.lowWireCost / lowM : 10);

              const highM = cb.highVoltageMeters || 0;
              setHighVoltageCost(highM > 0 ? cb.highWireCost / highM : 20);
            }

            // Optional: auto-fit map to loaded nodes
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
          }
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
      // ── CSV branch (PapaParse) ─────────────────────────
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        transformHeader: (h) => h.trim().toLowerCase(),
        complete: (result) => {
          try {
            const rows = result.data as Record<string, string>[];

            const parsedPoints: LocationPoint[] = rows
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
              .filter((p): p is LocationPoint => p !== null);

            console.log('Parsed CSV:', parsedPoints);

            if (parsedPoints.length === 0) {
              setError(
                'No valid rows found. Expected columns: Name, Type (source/terminal), Latitude, Longitude.'
              );
              setDataPoints([]);
            } else {
              setDataPoints(parsedPoints);
              setOriginalDataPoints(parsedPoints);
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
    // Reset anything derived from the previous data
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
    setDataPoints([]);

    // Generate random points within a 100 square mile area
    // 100 square miles is roughly 10 miles x 10 miles
    // 1 degree latitude ≈ 69 miles, so 10 miles ≈ 0.145 degrees,
    // 0.001 degrees ≈ 0.07 miles - more on the scale of the mini grids
    // Longitude degrees vary with latitude, but we'll use a center point
    const centerLat = 33.77728650419152; // Georgia Tech campus, Atlanta, GA
    const centerLng = -84.39617097270636;
    const latRange = 0.001; // small
    const lngRange = 0.001 / Math.cos((centerLat * Math.PI) / 180); // Adjust for longitude compression

    const points: LocationPoint[] = [];
    const maxAttempts = count * 10; // Prevent infinite loops
    let attempts = 0;

    while (points.length < count && attempts < maxAttempts) {
      // Generate coordinates with high precision

      const latOffset = (Math.random() - 0.5) * latRange * 2;
      const lngOffset = (Math.random() - 0.5) * lngRange * 2;

      // Maintain high precision by using more decimal places in calculation
      const lat = parseFloat((centerLat + latOffset).toFixed(8));
      const lng = parseFloat((centerLng + lngOffset).toFixed(8));

      // Check for duplicates (within 0.0001 degrees ≈ 30 feet)
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
            : `Terminal ${String(points.length + 1).padStart(2, '0')}`;

        points.push({
          name: name,
          type,
          lat,
          lng,
        });
      }
      attempts++;
    }

    if (points.length < count) {
      throw new Error(
        `Could not generate ${count} unique locations within the 100 square mile area. Try a smaller number of points.`
      );
    }
    setOriginalDataPoints(points);
    setDataPoints(points);
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
    let pointsToSend: LocationPoint[];

    console.log('Running solver with dataPoints:', dataPoints);
    console.log('miniGridNodes:', miniGridNodes);

    if (useExistingPoles && dataPoints.length > 0) {
      // Send ALL nodes (including poles) as fixed points
      pointsToSend = dataPoints.map((node) => ({
        name: node.name,
        type: node.type,
        lat: node.lat,
        lng: node.lng,
      }));
      console.log(
        `Sending ${pointsToSend.length} points INCLUDING ${poleCount} poles`
      );
    } else {
      // Default: loop through miniGridPoints and only take poinst that are not type pole
      pointsToSend = dataPoints
        .filter((node) => node.type !== 'pole')
        .map((node) => ({
          name: node.name,
          type: node.type,
          lat: node.lat,
          lng: node.lng,
        }));
    }

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

    setAllowDragTerminals(false);

    const backendUrl =
      process.env.NEXT_PUBLIC_BACKEND_URL || 'http://localhost:8000/solve';

    console.log(process.env.NEXT_PUBLIC_BACKEND_URL);

    console.log('Sending request to:', backendUrl);

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
      const edges = data.edges || [];

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

      setMiniGridNodes(data.nodes || []);

      // Update edges (now includes lengthMeters & voltage)
      setMiniGridEdges(
        edges.map((e: MiniGridEdge) => ({
          start: e.start,
          end: e.end,
          lengthMeters: e.lengthMeters ?? 0,
          voltage: e.voltage ?? 'low',
        }))
      );

      // Update cost breakdown state – directly from backend
      setCostBreakdown({
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
    console.log('Saved costs:', {
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

      {/* MAIN CONTAINER - Full Screen Map */}
      <div className='relative h-full overflow-hidden pt-16'>
        {/* FULL-BLEED MAP - Now fills the entire screen */}
        <div ref={mapRef} className='absolute inset-0 bg-zinc-950' />

        <div
          className={`fixed top-16 left-0 z-40 h-[calc(100vh-4rem)] border-r bg-white text-zinc-900 shadow-xl backdrop-blur-xl transition-all duration-200 lg:static lg:translate-x-0 dark:bg-zinc-950 dark:text-white dark:text-zinc-900 ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
          style={{ width: `${sidebarWidth}px` }}
        >
          {/* Resize Handle - Right edge */}
          <div
            className='absolute top-0 right-0 bottom-0 z-50 w-1.5 cursor-col-resize bg-zinc-300 transition-colors hover:bg-purple-500 active:bg-purple-600 dark:bg-zinc-700'
            onMouseDown={handleMouseDown}
          />

          {/* Scrollable Content */}
          <div className='h-full overflow-y-auto p-6'>
            <div className='space-y-12'>
              {/* 1. Define Locations Section */}
              <section>
                <button
                  onClick={() => toggleSection('locations')}
                  className='mb-6 flex w-full items-center justify-between rounded-xl bg-emerald-100 px-4 py-3 transition hover:bg-emerald-200 dark:bg-emerald-900/30 dark:hover:bg-emerald-900/40'
                >
                  <h2 className='light:text-emerald-700 text-lg font-bold text-emerald-700 dark:text-emerald-300'>
                    1. Define Locations
                  </h2>
                  <svg
                    className={`h-5 w-5 text-emerald-600 transition-transform dark:text-emerald-400 ${expandedSections.locations ? 'rotate-180' : ''}`}
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

                {expandedSections.locations && (
                  <div className='space-y-4'>
                    {/* Examples*/}
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
                      {error && <p className='mt-1.5 text-red-400'>{error}</p>}

                      {loading && (
                        <p className='mt-1.5 animate-pulse text-emerald-400'>
                          Processing…
                        </p>
                      )}
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

                    {/* Manual Point Card */}
                    <div className='rounded-xl border border-zinc-700/70 bg-white p-6 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <h3 className='mb-3 text-lg font-semibold text-zinc-100'>
                        Add Location Manually
                      </h3>
                      <form
                        onSubmit={handleAddManualPoint}
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
                                  type: e.target.value as 'source' | 'terminal',
                                })
                              }
                              className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-900 outline-none focus:border-emerald-500 dark:text-white'
                            >
                              <option value='terminal'>Terminal</option>
                              <option value='source'>Source</option>
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

                    {/* Saved Runs (conditional) */}
                    {session?.user && (
                      <div className='rounded-xl border border-zinc-700/70 bg-white p-6 backdrop-blur-sm lg:col-span-9 xl:col-span-3 dark:bg-zinc-900/50'>
                        <h3 className='mb-4 text-lg font-semibold text-zinc-100'>
                          Saved Mini-Grids ({savedRuns.length}/10)
                        </h3>
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

              {/* 2. Costs & Solver Section - (your existing code) */}
              <section>
                <button
                  onClick={() => toggleSection('costs')}
                  className='mb-6 flex w-full items-center justify-between rounded-2xl border border-purple-200 bg-purple-50 px-5 py-4 transition-all hover:bg-purple-100 dark:border-purple-500/30 dark:bg-purple-900/20 dark:hover:bg-purple-900/30'
                >
                  <h2 className='text-xl font-bold text-purple-700 dark:text-purple-300'>
                    2. Costs & Solver
                  </h2>
                  <svg
                    className={`h-5 w-5 text-purple-600 transition-transform dark:text-purple-400 ${expandedSections.costs ? 'rotate-180' : ''}`}
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

                {expandedSections.costs && (
                  <div className='space-y-4'>
                    <h3 className='mb-5 text-xl font-semibold text-zinc-100'>
                      Cost Parameters
                    </h3>
                    <div className='grid gap-6 sm:grid-cols-3'>
                      <div>
                        <label className='mb-2 block text-sm font-medium text-zinc-600 dark:text-zinc-300'>
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
                          className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm focus:border-emerald-500'
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
                          className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm focus:border-emerald-500'
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
                          className='w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2.5 text-sm focus:border-emerald-500'
                        />
                      </div>
                    </div>
                    <button
                      onClick={generateRandomCosts}
                      className='mt-5 text-sm text-emerald-400 hover:underline'
                    >
                      Use realistic random values
                    </button>

                    {/* Solver Selection + Parameters + Run */}
                    <div className='flex flex-col rounded-xl border border-zinc-700/70 bg-white p-7 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <h3 className='mb-5 text-xl font-semibold text-zinc-100'>
                        Solver Configuration
                      </h3>

                      {/* Solver Select */}
                      <div className='relative mb-6'>
                        <label
                          htmlFor='solver-select'
                          className='mb-2 block text-sm font-medium text-zinc-600 dark:text-zinc-300'
                        >
                          Select Solver
                        </label>
                        <select
                          id='solver-select'
                          value={selectedSolverName}
                          onChange={(e) =>
                            setSelectedSolverName(e.target.value)
                          }
                          className='w-full appearance-none rounded-lg border border-zinc-700/70 bg-zinc-800/70 px-4 py-3 pr-10 text-base font-medium text-zinc-100 focus:border-purple-500/60 focus:ring-2 focus:ring-purple-500/40'
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
                        <div className='pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4'>
                          <svg
                            className='h-5 w-5 text-zinc-400'
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
                        <div className='mt-4 flex items-center gap-3 rounded-lg border border-zinc-700/50 bg-zinc-900/40 p-4'>
                          <input
                            type='checkbox'
                            id='use-poles'
                            checked={useExistingPoles}
                            onChange={(e) =>
                              setUseExistingPoles(e.target.checked)
                            }
                            className='h-5 w-5 rounded border-zinc-600 bg-zinc-800 text-purple-600 focus:ring-purple-500'
                          />
                          <label
                            htmlFor='use-poles'
                            className='cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-300'
                          >
                            Use existing poles in calculation ({poleCount} poles
                            detected)
                          </label>
                        </div>
                      )}

                      {miniGridNodes.length > 0 && (
                        <div className='mt-4 flex items-center gap-3 rounded-lg border border-zinc-700/50 bg-zinc-900/40 p-4'>
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

                    {/* Solver Selection + Parameters + Run */}
                    <div className='flex flex-col rounded-xl border border-zinc-700/70 bg-white p-7 backdrop-blur-sm dark:bg-zinc-900/50'>
                      <h3 className='mb-5 text-xl font-semibold text-zinc-100'>
                        Solver Configuration
                      </h3>

                      {/* Solver Select */}
                      <div className='relative mb-6'>
                        <label
                          htmlFor='solver-select'
                          className='mb-2 block text-sm font-medium text-zinc-600 dark:text-zinc-300'
                        >
                          Select Solver
                        </label>
                        <select
                          id='solver-select'
                          value={selectedSolverName}
                          onChange={(e) =>
                            setSelectedSolverName(e.target.value)
                          }
                          className='w-full appearance-none rounded-lg border border-zinc-700/70 bg-zinc-800/70 px-4 py-3 pr-10 text-base font-medium text-zinc-100 focus:border-purple-500/60 focus:ring-2 focus:ring-purple-500/40'
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
                        <div className='pointer-events-none absolute inset-y-0 right-0 flex items-center pr-4'>
                          <svg
                            className='h-5 w-5 text-zinc-400'
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
                        <div className='mt-4 flex items-center gap-3 rounded-lg border border-zinc-700/50 bg-zinc-900/40 p-4'>
                          <input
                            type='checkbox'
                            id='use-poles'
                            checked={useExistingPoles}
                            onChange={(e) =>
                              setUseExistingPoles(e.target.checked)
                            }
                            className='h-5 w-5 rounded border-zinc-600 bg-zinc-800 text-purple-600 focus:ring-purple-500'
                          />
                          <label
                            htmlFor='use-poles'
                            className='cursor-pointer text-sm font-medium text-zinc-600 dark:text-zinc-300'
                          >
                            Use existing poles in calculation ({poleCount} poles
                            detected)
                          </label>
                        </div>
                      )}

                      {miniGridNodes.length > 0 && (
                        <div className='mt-4 flex items-center gap-3 rounded-lg border border-zinc-700/50 bg-zinc-900/40 p-4'>
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
                  <h2 className='text-xl font-bold text-blue-300'>
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
                    {solverOriginalCost > 0 && (
                      <div className='rounded-2xl border border-purple-500/30 bg-purple-900/20 p-6 text-center'>
                        <p className='text-xs font-bold tracking-widest text-purple-400 uppercase'>
                          Solver Cost
                        </p>
                        <p className='mt-1 text-4xl font-extrabold text-purple-300'>
                          ${formatUSD(solverOriginalCost)}
                        </p>
                      </div>
                    )}

                    {costBreakdown.grandTotal > 0 && (
                      <div className='rounded-2xl border border-emerald-500/30 bg-emerald-900/20 p-6 text-center'>
                        <p className='text-xs font-bold tracking-widest text-emerald-400 uppercase'>
                          Live Cost
                        </p>
                        <p className='mt-1 text-4xl font-extrabold text-emerald-700 dark:text-emerald-300'>
                          ${formatUSD(costBreakdown.grandTotal)}
                        </p>
                      </div>
                    )}

                    {costBreakdown.grandTotal !== 0 && (
                      <div
                        className={`rounded-2xl border p-6 text-center ${
                          isNegative
                            ? 'border-emerald-500/30 bg-emerald-900/20' // negative → green
                            : 'border-red-500/30 bg-red-900/20' // positive → red
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
                      </div>
                    )}

                    {miniGridNodes.length > 0 && (
                      <div>
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

                    {/* Mobile Overlay */}
                    {sidebarOpen && (
                      <div
                        className='fixed inset-0 z-30 bg-black/70 lg:hidden'
                        onClick={() => setSidebarOpen(false)}
                      />
                    )}
                  </div>
                )}
              </section>
            </div>
          </div>

          {/* Floating Reset Button - Clean positioning */}
          <button
            onClick={handleResetMap}
            disabled={dataPoints.length === 0 && miniGridNodes.length === 0}
            className='fixed right-15 bottom-6 z-50 flex items-center gap-2 rounded-full bg-red-600/90 px-6 py-3 text-sm font-medium text-zinc-900 shadow-2xl hover:bg-red-600 disabled:opacity-50 dark:text-white'
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
