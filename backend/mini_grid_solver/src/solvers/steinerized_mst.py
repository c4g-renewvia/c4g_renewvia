# optimizers/steinerized_mst.py

import math
from typing import List, Tuple, Dict, Any, Optional, Literal

import numpy as np

from .base_mini_grid_solver import BaseMiniGridSolver
from .registry import register_solver
from ..utils.models import SolverRequest, SolverResult, OutputEdge, Node

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
            request: SolverRequest containing points (lat/lng), costs, etc.
            max_edge_length: Maximum allowed length (meters) for any single cable segment.
                             Defaults to 30.0 meters.
        """
        super().__init__(request)
        self.max_edge_length = max_edge_length

    def solve(self) -> SolverResult:
        """
        Execute the full Steinerized MST algorithm and produce a SolverResult.

        Steps performed:
        1. Parse and validate input coordinates, source, terminals, names, and costs.
        2. Compute vectorized haversine distance matrix for all original points.
        3. Build MST using Kruskal's algorithm on the distance matrix.
        4. Traverse each MST edge; if too long, insert intermediate poles along great-circle.
        5. Build node list (source + terminals + extra poles) and edge list.
        6. Calculate wire lengths, pole count, and cost estimates.
        7. Return structured SolverResult ready for downstream use (UI, reporting, etc.).

        Returns:
            SolverResult with nodes, edges, metrics, and optional debug info.
        """
        # ─── 1. Parse input once and cache results ──────────────────────────────
        coords, source_idx, terminal_indices, names, costs = self.parse_and_validate_input()

        # ─── 2. Compute full distance matrix using vectorized haversine ─────────
        # This avoids O(n²) scalar calls and is much faster for moderate n
        dist_matrix = self.compute_distance_matrix(coords)

        # ─── 3. Build MST using Kruskal on the precomputed distances ────────────
        mst_edges = self._compute_mst_from_dist_matrix(dist_matrix)

        # ─── 4. Prepare data structures for final graph ─────────────────────────
        final_edges: List[OutputEdge] = []
        all_nodes: List[Node] = []
        extra_pole_indices: List[int] = []

        node_counter = 0
        # Use rounded tuple as approximate key to avoid duplicate nodes due to float precision
        point_to_node_idx: Dict[Tuple[float, float], int] = {}

        def add_node(lat: float, lng: float, name: str, node_type: Literal['terminal', 'source', 'pole'] = "pole") -> int:
            """Helper to create or reuse a Node and return its index."""
            nonlocal node_counter
            key = (round(lat, 8), round(lng, 8))  # High precision to deduplicate
            if key in point_to_node_idx:
                return point_to_node_idx[key]

            idx = node_counter
            node = Node(
                index=idx,
                lat=lat,
                lng=lng,
                name=name,
                type=node_type
            )
            all_nodes.append(node)
            point_to_node_idx[key] = idx
            node_counter += 1
            return idx

        # ─── 5. Add original source and terminal nodes first ────────────────────
        add_node(
            coords[source_idx, 0], coords[source_idx, 1],
            names[source_idx], "source"
        )

        for t_idx in terminal_indices:
            add_node(
                coords[t_idx, 0], coords[t_idx, 1],
                names[t_idx], "terminal"
            )

        # ─── 6. Process each MST edge: steinerize if necessary ──────────────────
        for i, j, orig_dist in mst_edges:
            p1 = coords[i]
            p2 = coords[j]

            # Generate sequence of points along great-circle path
            chain = self._great_circle_intermediates(
                p1[0], p1[1], p2[0], p2[1], self.max_edge_length
            )

            # Map chain points to node indices (reusing existing for endpoints)
            chain_node_indices = []
            for k, (lat, lng) in enumerate(chain):
                if k == 0:
                    # Start of edge → original point i
                    node_idx = add_node(
                        lat, lng,
                        names[i] if i == source_idx else f"Building {i}",
                        "source" if i == source_idx else "terminal"
                    )
                elif k == len(chain) - 1:
                    # End of edge → original point j
                    node_idx = add_node(
                        lat, lng,
                        names[j] if j in terminal_indices else f"Building {j}",
                        "terminal"
                    )
                else:
                    # Intermediate pole
                    pole_name = f"Pole {len(extra_pole_indices) + 1}"
                    node_idx = add_node(lat, lng, pole_name, "pole")
                    extra_pole_indices.append(node_idx)

                chain_node_indices.append(node_idx)

            # Connect consecutive nodes in the chain with OutputEdge objects
            for a_idx, b_idx in zip(chain_node_indices[:-1], chain_node_indices[1:]):
                a_node = all_nodes[a_idx]
                b_node = all_nodes[b_idx]
                length_m = self.haversine_meters(
                    a_node.lat, a_node.lng, b_node.lat, b_node.lng
                )
                final_edges.append(OutputEdge(
                    start={ "lat": a_node.lat, "lng": a_node.lng },
                    end={ "lat": b_node.lat, "lng": b_node.lng },
                    lengthMeters=round(length_m, 2),
                    voltage="low"  # Future: could classify high/low based on proximity to source
                ))

        # ─── 7. Compute metrics and build final result ──────────────────────────
        num_extra_poles = len(extra_pole_indices)
        total_low_voltage_m = sum(e.lengthMeters for e in final_edges)
        total_high_voltage_m = 0.0  # Currently all low-voltage

        debug_info = {
            "algorithm": "Steinerized Minimum Spanning Tree",
            "max_edge_length_m": self.max_edge_length,
            "original_points": len(coords),
            "original_mst_edges": len(mst_edges),
            "final_segments": len(final_edges),
            "extra_poles_added": num_extra_poles,
            "total_length_m": round(total_low_voltage_m, 2),
        }

        return self.build_simple_result(
            edges=final_edges,
            used_nodes=all_nodes,
            total_low_m=total_low_voltage_m,
            total_high_m=total_high_voltage_m,
            num_poles=num_extra_poles,
            debug_info=debug_info if self.request.debug else None
        )

    def _compute_mst_from_dist_matrix(self, dist_matrix: np.ndarray) -> List[Tuple[int, int, float]]:
        """
        Run Kruskal's algorithm to compute MST using a precomputed distance matrix.

        Args:
            dist_matrix: (n × n) symmetric matrix of haversine distances in meters.

        Returns:
            List of (i, j, distance) tuples for edges included in the MST.
        """
        n = dist_matrix.shape[0]
        edge_list = []

        # Collect all unique pairs (upper triangle only)
        for i in range(n):
            for j in range(i + 1, n):
                edge_list.append((dist_matrix[i, j], i, j))

        edge_list.sort()  # Sort by increasing distance

        parent = list(range(n))
        rank = [0] * n

        def find(x: int) -> int:
            if parent[x] != x:
                parent[x] = find(parent[x])
            return parent[x]

        def union(x: int, y: int) -> bool:
            px, py = find(x), find(y)
            if px == py:
                return False
            if rank[px] < rank[py]:
                parent[px] = py
            elif rank[px] > rank[py]:
                parent[py] = px
            else:
                parent[py] = px
                rank[px] += 1
            return True

        mst_edges = []
        for distance, i, j in edge_list:
            if union(i, j):
                mst_edges.append((i, j, distance))
            if len(mst_edges) == n - 1:
                break

        return mst_edges

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
        # Convert to radians
        lat1_rad, lon1_rad = np.radians(lat1), np.radians(lon1)
        lat2_rad, lon2_rad = np.radians(lat2), np.radians(lon2)

        # 3D unit vectors (ECEF-like, but normalized)
        def latlon_to_unit_vector(lat_rad: float, lon_rad: float) -> np.ndarray:
            cos_lat = np.cos(lat_rad)
            return np.array([
                cos_lat * np.cos(lon_rad),
                cos_lat * np.sin(lon_rad),
                np.sin(lat_rad)
            ])

        v1 = latlon_to_unit_vector(lat1_rad, lon1_rad)
        v2 = latlon_to_unit_vector(lat2_rad, lon2_rad)

        # Great-circle distance (for segment count)
        total_distance = self.haversine_meters(lat1, lon1, lat2, lon2)
        if total_distance <= max_length:
            return [(lat1, lon1), (lat2, lon2)]

        num_segments = math.ceil(total_distance / max_length)
        num_intermediates = num_segments - 1

        points = [(lat1, lon1)]

        # Angular distance between v1 and v2
        dot = np.clip(np.dot(v1, v2), -1.0, 1.0)
        omega = np.arccos(dot)  # central angle in radians

        if omega < 1e-9:  # points are essentially the same
            return [(lat1, lon1), (lat2, lon2)]

        sin_omega = np.sin(omega)

        for k in range(1, num_intermediates + 1):
            t = k / num_segments  # fraction along the path [0..1]

            # Spherical linear interpolation coefficients
            a = np.sin((1 - t) * omega) / sin_omega
            b = np.sin(t * omega) / sin_omega

            # Interpolated vector
            v_interp = a * v1 + b * v2
            v_interp /= np.linalg.norm(v_interp)  # normalize back to unit sphere

            # Convert back to lat/lon
            lat_rad = np.arcsin(v_interp[2])
            lon_rad = np.arctan2(v_interp[1], v_interp[0])

            lat_deg = np.degrees(lat_rad)
            lon_deg = np.degrees(lon_rad)

            points.append((lat_deg, lon_deg))

        points.append((lat2, lon2))
        return points