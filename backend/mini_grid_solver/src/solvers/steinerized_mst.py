# optimizers/steinerized_mst.py

import math
from typing import List, Tuple

import networkx as nx
import numpy as np

from .base_mini_grid_solver import BaseMiniGridSolver
from .registry import register_solver
from ..utils.models import SolverRequest, Node


@register_solver
class SteinerizedMSTSolver(BaseMiniGridSolver):
    """
    Mini-grid power network optimizer using the Steinerized Minimum Spanning Tree heuristic.

    This solver provides a practical, fast approximation for laying out a mini-grid
    under a strict maximum edge length constraint (e.g., 30 meters per cable segment
    due to voltage drop, safety, or installation rules).

    Algorithm overview:
    1. Compute the Euclidean (haversine) Minimum Spanning Tree (MST) on the original
       set of points: 1 power source + N buildings/terminals.
    2. For every MST edge longer than max_edge_length, insert evenly spaced intermediate
       "pole" nodes along the great-circle path to ensure no single cable segment exceeds
       the allowed length.
    3. The resulting structure is a tree rooted at the power source, connecting all
       terminals with only short edges.

    Strengths:
    - Guarantees all edges ≤ max_edge_length
    - Fast (O(n² log n) worst-case, but practical for hundreds of points)
    - Simple to implement and debug
    - Provides a good baseline (often within 1.5–2× optimal number of extra poles in practice)

    Limitations:
    - Does not attempt to add "true" Steiner points at optimal 120° junctions
    - Pole placement is purely linear along MST edges (no merging or optimization)
    - Uses linear interpolation in lat/lon for intermediates (sufficient for short segments)

    Typical use case: Rural mini-grids where pole installation cost dominates and
    maximum span is constrained (e.g., 30 m due to low-voltage cable limits).
    """

    def __init__(self, request: SolverRequest, max_edge_length: float = 30.0):
        """
        Initialize the solver with the input request and edge length constraint.

        Args:
            request: SolverRequest containing points (lat/lng), solver, etc.
            max_edge_length: Maximum allowed length (meters) for any single cable segment.
                             Defaults to 30.0 meters.
        """
        super().__init__(request)
        self.max_edge_length = max_edge_length

    def _solve(self, input_tuple) -> Tuple[nx.Graph, list[Node], np.ndarray]:
        """
        Execute the full Steinerized MST algorithm and produce a SolverResult.

        Returns:
            graph, nodes, coords: The resulting graph structure,
                list of nodes (including any new poles),
                the actual coordinates themselves
        """
        # ─── 1. Parse input once and cache results ──────────────────────────────
        nodes, coords, source_idx, terminal_indices, names, costs = input_tuple

        # ─── 2. Compute full distance matrix using vectorized haversine ─────────
        # This avoids O(n²) scalar calls and is much faster for moderate n
        dist_matrix = self.compute_distance_matrix(coords)

        n = len(coords)

        G = nx.complete_graph(n)
        for i in range(n):
            for j in range(i + 1, n):
                d = dist_matrix[i, j]
                weight = d * costs["lowVoltageCostPerMeter"]
                G.edges[i, j]["weight"] = weight
                G.edges[i, j]["length"] = d
                G.edges[i, j]["voltage"] = "low"
        mst = nx.minimum_spanning_tree(G, weight="weight")

        # ─── 6. Process each MST edge: steinerize if necessary ──────────────────
        new_node_counter = n  # start numbering new poles from original n

        for u, v, data in list(mst.edges(data=True)):  # use list() because we modify graph
            orig_length = data["length"]
            if orig_length <= self.max_edge_length:
                continue  # no need to steinerize

            p1 = coords[u]
            p2 = coords[v]

            # Get intermediate points (excluding endpoints)
            intermediates = self._great_circle_intermediates(
                p1[0], p1[1], p2[0], p2[1], self.max_edge_length
            )

            if not intermediates:
                continue

            # ─── Build chain: original u → new1 → new2 → ... → new_k → original v ───
            prev = u
            new_nodes_in_chain = []

            for lat, lon in intermediates:
                # Create new node
                new_id = new_node_counter
                new_node_counter += 1

                # Add to global lists
                node = Node(index=new_id, lat=lat, lng=lon, type="pole", name=f"Pole {new_id}")
                nodes.append(node)  # or use better naming scheme
                coords = np.vstack([coords, [lat, lon]])
                new_nodes_in_chain.append(new_id)

                # Connect previous → new
                d = self.haversine_meters(coords[prev, 0], coords[prev, 1], lat, lon)
                weight = d * costs["lowVoltageCostPerMeter"]

                mst.add_edge(prev, new_id,
                             weight=weight,
                             length=d,
                             voltage="low")

                prev = new_id

            # Final segment: last new node → original v
            d = self.haversine_meters(coords[prev, 0], coords[prev, 1], coords[v, 0], coords[v, 1])
            weight = d * costs["lowVoltageCostPerMeter"]

            mst.add_edge(prev, v,
                         weight=weight,
                         length=d,
                         voltage="low")

            # ─── Remove the original long edge ────────────────────────────────
            mst.remove_edge(u, v)

        return mst, nodes, coords

    def _great_circle_intermediates(
            self,
            lat1: float, lon1: float,
            lat2: float, lon2: float,
            max_length: float
    ) -> List[Tuple[float, float]]:
        """
        Generate intermediate points along the true great-circle path using vector math.

        Converts lat/lon to 3D Cartesian unit vectors,
        interpolates angularly (SLERP-like), then converts back to lat/lon.

        This is more accurate than linear lat/lon interpolation, especially for longer segments.

        Args:
            lat1, lon1: Start point (degrees)
            lat2, lon2: End point (degrees)
            max_length: Max allowed segment length in meters

        Returns:
            List of (lat, lon) tuples: [start, inter1, inter2, ..., end]
        """
        lat1_rad = np.radians(lat1)
        lon1_rad = np.radians(lon1)
        lat2_rad = np.radians(lat2)
        lon2_rad = np.radians(lon2)

        v1 = np.array([
            np.cos(lat1_rad) * np.cos(lon1_rad),
            np.cos(lat1_rad) * np.sin(lon1_rad),
            np.sin(lat1_rad)
        ])
        v2 = np.array([
            np.cos(lat2_rad) * np.cos(lon2_rad),
            np.cos(lat2_rad) * np.sin(lon2_rad),
            np.sin(lat2_rad)
        ])

        total_distance = self.haversine_meters(lat1, lon1, lat2, lon2)
        if total_distance <= max_length:
            return []  # ← important: empty list

        num_segments = math.ceil(total_distance / max_length)
        num_intermediates = num_segments - 1

        if num_intermediates <= 0:
            return []

        dot = np.clip(np.dot(v1, v2), -1.0, 1.0)
        omega = np.arccos(dot)
        if omega < 1e-9:
            return []

        sin_omega = np.sin(omega)

        intermediates = []

        for k in range(1, num_intermediates + 1):
            t = k / num_segments
            a = np.sin((1 - t) * omega) / sin_omega
            b = np.sin(t * omega) / sin_omega
            v_interp = a * v1 + b * v2
            v_interp /= np.linalg.norm(v_interp)

            lat_rad = np.arcsin(v_interp[2])
            lon_rad = np.arctan2(v_interp[1], v_interp[0])

            intermediates.append((
                np.degrees(lat_rad),
                np.degrees(lon_rad)
            ))

        return intermediates
