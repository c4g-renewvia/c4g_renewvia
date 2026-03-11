# optimizers/base.py
import math
from abc import ABC, abstractmethod
from typing import Tuple

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
    def get_bounding_box(coords):
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
    def parse_input(request: SolverRequest, debug: bool = False):
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
            try:
                lat = float(p["lat"])
                lng = float(p["lng"])
            except (KeyError, TypeError, ValueError) as e:
                raise ValueError(f"Point {i + 1} missing/invalid lat/lng: {p}") from e

            if not (-90 <= lat <= 90) or not (-180 <= lng <= 180):
                raise ValueError(f"Point {i + 1} has invalid coordinates: ({lat}, {lng})")

            coords_list.append([lat, lng])

            # Name handling
            raw_name = p.get("Name")
            if raw_name is not None:
                name = f"{str(raw_name).strip()} {i + 1}"
            else:
                name = f"Location {i + 1}"

            names.append(name)

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

    def parse_and_validate_input(self) -> Tuple[np.ndarray, int, List[int], List[str], Dict[str, float]]:
        """
        Default robust input parser — most subclasses will just call this.
        """
        if self._coords is not None:
            return self._coords, self._source_idx, self._terminal_indices, self._names, self._costs

        self._coords, self._terminal_indices, self._source_idx, self._names, self._costs = self.parse_input(
            self.request, debug=self.request.debug)

        # You can add more validation / normalization here if desired
        if len(self._coords) < 2:
            raise ValueError("Need at least source + 1 terminal")

        self._costs = self._costs or {}
        # Ensure default costs exist (subclasses can still override/ignore)
        self._costs.setdefault("poleCost", 100.0)
        self._costs.setdefault("lowVoltageCostPerMeter", 10.0)
        self._costs.setdefault("highVoltageCostPerMeter", 20.0)

        return self._coords, self._source_idx, self._terminal_indices, self._names, self._costs

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
