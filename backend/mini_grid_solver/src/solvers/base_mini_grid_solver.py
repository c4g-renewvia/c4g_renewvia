# optimizers/base.py
import math
from abc import ABC, abstractmethod
from typing import Tuple

import networkx as nx
import numpy as np

from ..utils.models import *


class BaseMiniGridSolver(ABC):
    """
    Abstract base class for MiniGrid power network optimizers.

    Subclasses implement different algorithms/heuristics while agreeing on:
      - Input  = SolverRequest
      - Output = SolverResult (edges, nodes, metrics, optional debug)

    No assumptions are made about:
      - Use of candidate poles
      - MST / Steiner tree / arborescence
      - Voltage assignment logic
      - Edge fragmentation / pole placement density
      - Cost model details
    """

    def __init__(self, request: SolverRequest):
        self.request = request
        self._coords: Optional[np.ndarray] = None
        self._source_idx: Optional[int] = None
        self._terminal_indices: Optional[List[int]] = None
        self._names: Optional[List[str]] = None
        self._costs: Optional[Dict[str, float]] = None

    # ─── Static Helper methods ───────────────────────────────────────────────
    @staticmethod
    def compute_bounding_box(coords):
        """
        Compute axis-aligned bounding box from array of [lat, lon] points.

        Args:
            coords: np.ndarray of shape (n, 2) where each row is [latitude, longitude]
                    or list of [lat, lon] pairs

        Returns:
            dict: {'min_lat': float, 'max_lat': float, 'min_lon': float, 'max_lon': float}
                  or None if input is empty/invalid
        """
        if len(coords) == 0:
            return None

        # Convert to numpy array if it's a list
        coords = np.asarray(coords)

        if coords.ndim != 2 or coords.shape[1] != 2:
            raise ValueError("coords must be (n, 2) array or list of [lat, lon] pairs")

        min_lat = np.min(coords[:, 0])
        max_lat = np.max(coords[:, 0])
        min_lon = np.min(coords[:, 1])
        max_lon = np.max(coords[:, 1])

        return {
            'min_lat': float(min_lat),
            'max_lat': float(max_lat),
            'min_lng': float(min_lon),
            'max_lng': float(max_lon)
        }

    @staticmethod
    def is_duplicate(c, existing):
        return any(np.allclose(c, np.array(p), atol=1e-6) for p in existing)

    @staticmethod
    def haversine_meters(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
        """Calculate the great-circle distance between two points on Earth in meters.

        Uses the Haversine formula to compute distance between two latitude/lnggitude pairs.

        Args:
            lat1 (float): Latitude of the first point in degrees.
            lng1 (float): longitude of the first point in degrees.
            lat2 (float): Latitude of the second point in degrees.
            lng2 (float): longitude of the second point in degrees.

        Returns:
            float: Distance in meters.
            """
        R = 6371000.0  # Earth mean radius in meters
        phi1 = math.radians(lat1)
        phi2 = math.radians(lat2)
        dphi = math.radians(lat2 - lat1)
        dlam = math.radians(lng2 - lng1)

        a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
        c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
        return R * c

    @staticmethod
    def haversine_vec(A, B):
        """
        Computes the Haversine distance between two sets of points.
        Args:
            A: (n, 2) array of [lat, lon]
            B: (n, 2) array of [lat, lon]
        """
        # A, B: (n, 2) arrays of [lat, lon]
        lat1, lon1 = np.radians(A[:, 0]), np.radians(A[:, 1])
        lat2, lon2 = np.radians(B[:, 0]), np.radians(B[:, 1])
        dlat = lat2 - lat1[:, None]
        dlon = lon2 - lon1[:, None]
        a = np.sin(dlat / 2) ** 2 + np.cos(lat1[:, None]) * np.cos(lat2) * np.sin(dlon / 2) ** 2
        c = 2 * np.arctan2(np.sqrt(a), np.sqrt(1 - a))
        return 6371000 * c  # shape (n_candidates, n_buildings)

    @staticmethod
    def parse_input(request: SolverRequest, poles: bool = True, debug: bool = False):
        """
        Parses input request containing information about geographical points, costs, and their attributes to generate structured
        data suitable for optimization tasks.

        This function processes the input `SolverRequest` to extract coordinates, their names, and classify one of the
        locations as the "Power Source". It ensures that the input contains at least two valid points, assigns a "Power Source"
        if not explicitly provided, and organizes the remaining points as terminals. The function also validates and cleans input
        data for consistency.

        Args:
            request: Input request containing points and their associated costs

        Returns:
            A tuple containing coords, terminal_indices, source_idx, original_names, costs
        """

        points = request.points
        costs = request.costs.copy()  # defensive copy

        if len(points) < 2:
            raise ValueError("At least 2 points required")

        coords_list = []
        names = []
        source_idx = None

        SOURCE_KEYWORDS = {
            "power source", "powersource", "source", "substation", "main source",
            "primary", "generator", "grid tie", "utility"
        }

        for i, p in enumerate(points):
            # Name handling
            raw_name = p.get("name")

            if poles and "pole" in raw_name.lower():
                continue

            if raw_name is not None:
                try:
                    int(raw_name.split(" ")[-1])
                    name = raw_name
                except:
                    name = f"{str(raw_name).strip()} {i + 1}"
            else:
                name = f"Location {i + 1}"

            names.append(name)

            try:
                lat = float(p["lat"])
                lng = float(p["lng"])
            except (KeyError, TypeError, ValueError) as e:
                raise ValueError(f"Point {i + 1} missing/invalid lat/lng: {p}") from e

            if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
                raise ValueError(f"Point {i + 1} has invalid coordinates: ({lat}, {lng})")

            coords_list.append([lat, lng])



            # Source detection (case-insensitive, more flexible)
            name_lower = name.lower()
            if any(kw in name_lower for kw in SOURCE_KEYWORDS) or "source" in name_lower:
                if source_idx is not None:
                    print(f"Warning: Multiple potential sources detected; using first (index {source_idx})")
                else:
                    source_idx = i
                    names[i] = "Power Source"  # canonical name

        coords = np.array(coords_list, dtype=np.float64)

        if source_idx is None:
            if debug:
                print("No explicit power source found → using first point (index 0)")
            source_idx = 0
            names[0] = "Power Source"

        terminal_indices = [i for i in range(len(coords)) if i != source_idx]

        return coords, terminal_indices, source_idx, names, costs

    # ─── Core abstract methods ───────────────────────────────────────────────

    @abstractmethod
    def solve(self) -> SolverResult:
        """
        Main entry point: take the request → produce full SolverResult.

        This is the only method most users / tests should call directly.
        """
        pass

    # ─── Helpful common utilities (can be used or overridden) ────────────────
    def _build_nodes(self, coords, candidates, source_idx, terminals, names):
        nodes = []
        n_orig = len(coords)

        for i in range(n_orig):
            if i == source_idx:
                t = "source"
            else:
                if "pole" in names[i].lower():
                    t = "pole"
                else:
                    t = "terminal"
            nodes.append(Node(
                index=i,
                lat=float(coords[i, 0]),
                lng=float(coords[i, 1]),
                type=t,
                name=names[i],
                is_candidate=False,
                used=True,  # originals always kept
            ))

        offset = n_orig
        for j, (lat, lon) in enumerate(candidates, start=offset):
            nodes.append(Node(
                index=j,
                lat=float(lat),
                lng=float(lon),
                type="pole",
                is_candidate=True,
                used=False,
            ))

        return nodes

    def parse_and_validate_input(self, poles: bool = True) -> Tuple[list[Node], np.ndarray, int, List[int], List[str], Dict[str, float]]:
        """
        Parses and validates the input data for constructing nodes. This includes parsing input data
        such as coordinates, source index, terminal indices, names, and costs, as well as ensuring
        basic operational validity through validation checks and setting default costs if not
        provided.

        Args:
            poles (bool): Determines whether poles should be included in the constructed nodes.

        Returns:
            Tuple[list[Node], np.ndarray, int, List[int], List[str], Dict[str, float]]:
            A tuple containing the constructed nodes, coordinates, source index,
            terminal indices, names, and cost mappings.

        Raises:
            ValueError: If the input does not contain at least one source and one terminal.
        """
        if self._coords is not None:
            return self._coords, self._source_idx, self._terminal_indices, self._names, self._costs

        self._coords, self._terminal_indices, self._source_idx, self._names, self._costs = self.parse_input(
            self.request, poles=poles, debug=self.request.debug)

        # You can add more validation / normalization here if desired
        if len(self._coords) < 2:
            raise ValueError("Need at least source + 1 terminal")

        self._costs = self._costs or {}
        # Ensure default costs exist (subclasses can still override/ignore)
        self._costs.setdefault("poleCost", 100.0)
        self._costs.setdefault("lowVoltageCostPerMeter", 10.0)
        self._costs.setdefault("highVoltageCostPerMeter", 20.0)

        self._nodes = self._build_nodes(self._coords, [], self._source_idx, self._terminal_indices, self._names)

        return self._nodes, self._coords, self._source_idx, self._terminal_indices, self._names, self._costs

    def build_directed_graph_for_arborescence(
            self,
            source_idx,
            terminal_indices,
            pole_indices,
            dist_matrix,
            costs,
            max_pole_to_pole_lv=30,
            max_pole_to_terminal_lv=30,
    ) -> nx.DiGraph:
        """
        Builds a directed graph for use in finding a minimum-cost arborescence given
        a set of coordinates, indices, and constraints.

        This function constructs a directed graph where poles and terminals are represented
        as nodes, and edges represent potential connections between them. Different weight
        and voltage attributes are applied to the edges depending on their type (pole-to-terminal,
        pole-to-pole, or source-to-pole/terminal connections).

        Args:
            source_idx: Integer index representing the source node (e.g., a substation).
            terminal_indices: List of integers representing indices of all terminals.
            pole_indices: List of integers representing indices of all poles.
            dist_matrix: 2D matrix where each element represents the distance between nodes.
            costs: Dictionary storing cost values for graph construction. Specifically,
                   it should include the `"poleCost"` key to determine the cost addition
                   for pole-to-pole connections.

        Returns:
            nx.DiGraph: A directed graph with the defined nodes and edges.

        """

        pole_cost = float(costs.get("poleCost", 100.0))
        low_voltage_cost_per_meter = float(costs.get("lowVoltageCostPerMeter", 10.0))
        high_voltage_cost_per_meter = float(costs.get("highVoltageCostPerMeter", 20.0))

        DG = nx.DiGraph()

        # 1: source → poles (main trunk)
        for p in pole_indices:
            d = dist_matrix[source_idx, p]
            if 0.1 < d:
                w = (d * low_voltage_cost_per_meter) + pole_cost
                extra_poles_needed = int(d // max_pole_to_pole_lv)
                w += extra_poles_needed * pole_cost

                DG.add_edge(source_idx, p, weight=w, length=d, voltage="low")

        # 2: Bidirectional pole ↔ pole (undirected spans)
        for i in range(len(pole_indices)):
            for j in range(i + 1, len(pole_indices)):
                p1, p2 = pole_indices[i], pole_indices[j]
                d = dist_matrix[p1, p2]

                # cost of wire and pole
                w = (d * low_voltage_cost_per_meter) + pole_cost
                extra_poles_needed = int(d // max_pole_to_pole_lv)
                w += extra_poles_needed * pole_cost

                if 0.1 < d:
                    DG.add_edge(p1, p2, weight=w, length=d, voltage="low")

        # 3: poles → terminals (service drops)
        for p in pole_indices:
            for h in terminal_indices:
                d = dist_matrix[p, h]
                if 0.1 < d:
                    # cost of wire
                    w = d * low_voltage_cost_per_meter

                    extra_poles_needed = int(d // max_pole_to_terminal_lv)
                    w += extra_poles_needed * pole_cost

                    DG.add_edge(p, h, weight=w, length=d, voltage="low")

        return DG

    def extract_used_nodes(self, mst, nodes):
        """
        Extracts and processes nodes that are used within the provided pruned minimum
        spanning tree (MST). Marks the nodes as used, assigns them a name if they are
        of type "pole" and lack a name, and returns the list of used nodes.

        Args:
            mst: The pruned minimum spanning tree used to determine which
                nodes to mark and process.
            nodes: A list of nodes, where each node has attributes such as `index`,
                `used`, `type`, and `name`.

        Returns:
            list: A list of nodes that are used, with appropriate properties updated
            based on the given MST and node attributes.
        """
        used_indices = set(mst.nodes)
        pole_counter = 1
        used_nodes = []
        for node in nodes:
            if node.index in used_indices:
                node.used = True
                if node.type == "pole" and not node.name:
                    node.name = f"Pole {pole_counter}"
                    pole_counter += 1
                used_nodes.append(node)
        return used_nodes

    def prune_dead_end_pole_branches(self, DG: nx.DiGraph, pole_indices: list, terminal_indices) -> nx.DiGraph:
        """
        Prunes dead-end pole branches in a Directed Graph (DiGraph).

        This function removes leaf nodes in the provided graph that represent poles and do not serve
        any terminal nodes in their subtree. The pruning process continues iteratively until no such
        dead-end poles remain in the graph. It modifies a copy of the input graph without affecting
        the original.

        Args:
            DG (nx.DiGraph): A directed graph representing the network structure.
            pole_indices (list): A list of node indices representing poles in the graph.
            terminal_indices (list): A list of node indices representing terminals in the graph.

        Returns:
            nx.DiGraph: A new directed graph with dead-end pole branches removed.
        """
        DG = DG.copy()
        removed = True
        while removed:
            removed = False
            leaves = [n for n in DG.nodes() if DG.out_degree(n) == 0]
            for leaf in leaves:
                if leaf in pole_indices:
                    # Check if this leaf (or its subtree) serves any terminal
                    descendants = nx.descendants(DG, leaf) | {leaf}
                    if not any(d in terminal_indices for d in descendants):
                        # No terminal served → safe to remove
                        predecessors = list(DG.predecessors(leaf))
                        for pred in predecessors:
                            DG.remove_edge(pred, leaf)
                        DG.remove_node(leaf)
                        removed = True
        return DG

    def _build_edges_and_lengths(self, graph: nx.DiGraph, nodes: List[Node]):
        edges = []
        low_m = high_m = 0.0

        for u, v, d in graph.edges(data=True):
            length = d.get("length", 0.0)
            voltage = d.get("voltage", "unknown")

            start = next(n for n in nodes if n.index == u)
            end = next(n for n in nodes if n.index == v)

            edges.append(OutputEdge(
                start={"lat": start.lat, "lng": start.lng, "name": start.name, "type": start.type},
                end={"lat": end.lat, "lng": end.lng, "name": end.name, "type": end.type},
                lengthMeters=round(length, 2),
                voltage=voltage,
            ))

            if voltage == "low":
                low_m += length
            elif voltage == "high":
                high_m += length

        return edges, low_m, high_m

    def build_simple_result(
            self,
            edges: List[OutputEdge],
            used_nodes: List[Node],
            total_low_m: float = 0.0,
            total_high_m: float = 0.0,
            num_poles: int = 0,
            debug_info: Optional[Dict[str, Any]] = None,
    ) -> SolverResult:
        """
        Helper to construct a valid SolverResult from the most common pieces.
        Many simple algorithms can just produce edges + used nodes and call this.
        """
        pole_cost = self._costs.get("poleCost", 1500.0)
        low_cost_m = self._costs.get("lowVoltageCostPerMeter", 8.0)
        high_cost_m = self._costs.get("highVoltageCostPerMeter", 25.0)

        low_wire_cost = total_low_m * low_cost_m
        high_wire_cost = total_high_m * high_cost_m
        total_wire_cost = low_wire_cost + high_wire_cost
        total_cost = total_wire_cost + num_poles * pole_cost

        node_dicts = [
            {
                "index": n.index,
                "lat": n.lat,
                "lng": n.lng,
                "name": n.name or f"{n.type.title()} {n.index}",
                "type": n.type,
            }
            for n in used_nodes
        ]

        return SolverResult(
            edges=edges,
            nodes=node_dicts,
            totalLowVoltageMeters=round(total_low_m, 2),
            totalHighVoltageMeters=round(total_high_m, 2),
            numPolesUsed=num_poles,
            poleCostEstimate=round(num_poles * pole_cost, 2),
            lowWireCostEstimate=round(low_wire_cost, 2),
            highWireCostEstimate=round(high_wire_cost, 2),
            totalWireCostEstimate=round(total_wire_cost, 2),
            totalCostEstimate=round(total_cost, 2),
            debug=debug_info if self.request.debug else None,
        )

    def compute_distance_matrix(self, points: np.ndarray) -> np.ndarray:
        """Default haversine distance matrix — override if you want Euclidean, etc."""
        return self.haversine_vec(points, points)

    def get_all_points(self) -> np.ndarray:
        """Convenience: return (n_points, 2) array of all original lat/lon"""
        self.parse_and_validate_input()  # ensure parsed
        return self._coords

    def source_coord(self) -> np.ndarray:
        self.parse_and_validate_input()
        return self._coords[self._source_idx]

    def terminal_coords(self) -> np.ndarray:
        self.parse_and_validate_input()
        return self._coords[self._terminal_indices]
