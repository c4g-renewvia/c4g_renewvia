# # backend/mst.py
import math
from typing import Tuple

import networkx as nx
import numpy as np
import pandas as pd
from scipy.spatial import Voronoi, Delaunay
from shapely.geometry import Point
from shapely.wkt import loads

from .base_mini_grid_solver import *
from ..utils.models import *




class CandidateMSTSolver(BaseMiniGridSolver):
    """
    Re-implementation of your original MST + Fermat candidates + pruning + fragmentation logic.
    Exists mainly as reference / regression test baseline.
    """

    def __init__(self, request: SolverRequest):
        """

        Args:
            - request: SolverRequest object containing all necessary parameters.
            - candidate_algorithm: specifying the algorithm to use for generating candidates.
                `voronoi` for Voronoi vertices, `fermat` for Fermat-Torricelli points.
        """
        super().__init__(request)
        self.candidate_algorithm = request.params.get("candidate_algorithm", "voronoi")

    def _great_circle_intermediates(
            self,
            lat1: float, lon1: float,
            lat2: float, lon2: float,
            max_length: float
    ) -> List[Tuple[float, float]]:
        """
        Calculates intermediate points on the great-circle path between two geographical coordinates.

        This function computes a series of intermediate latitude and longitude points along the
        great-circle path between two given geographical coordinates, ensuring that the
        distance between consecutive points does not exceed a specified maximum length.

        Args:
            lat1: Latitude of the starting point in decimal degrees.
            lon1: Longitude of the starting point in decimal degrees.
            lat2: Latitude of the ending point in decimal degrees.
            lon2: Longitude of the ending point in decimal degrees.
            max_length: Maximum allowed distance between consecutive points in meters.

        Returns:
            List of tuples representing the latitude and longitude of each point along
            the path, including the starting and ending points.
        """
        d = self.haversine_meters(lat1, lon1, lat2, lon2)
        if d <= max_length:
            return [(lat1, lon1), (lat2, lon2)]

        n_segments = math.ceil(d / max_length)
        n_inter = n_segments - 1
        step_dist = d / n_segments

        points = [(lat1, lon1)]

        # Very simple linear interpolation in lat/lon space (good enough for short distances < few km)
        # For higher accuracy over long distances → use proper great-circle intermediate formula
        for k in range(1, n_inter + 1):
            frac = k / n_segments
            lat = lat1 + frac * (lat2 - lat1)
            lon = lon1 + frac * (lon2 - lon1)
            points.append((lat, lon))

        points.append((lat2, lon2))
        return points

    def generate_collinear_candidates(
            self,
            coords,  # usually np.ndarray (n, 2)
            current_tree_edges,
            max_length: float = 30.0,
            num_per_edge: int = 3
    ) -> np.ndarray:
        """
        Generate ~num_per_edge intermediate candidates per long edge.
        """
        candidates = []

        for u, v in current_tree_edges:
            p1 = coords[u]  # [lat, lon]
            p2 = coords[v]
            d = self.haversine_meters(p1[0], p1[1], p2[0], p2[1])

            if d <= max_length:
                continue

            # We want ~ num_per_edge intermediate points
            # → number of segments = num_per_edge + 1
            n_segments_desired = num_per_edge + 1
            segment_length = d / n_segments_desired

            # But never make segments shorter than, say, 5–10 m
            # segment_length = max(segment_length, 8.0)  # adjust as needed

            intermediates = self._great_circle_intermediates(
                p1[0], p1[1],
                p2[0], p2[1],
                max_length=segment_length  # ← this is the key fix
            )

            # intermediates includes start + end → take only the middle ones
            for pt in intermediates[1:-1]:
                candidates.append(np.array(pt))

        if not candidates:
            return np.empty((0, 2), dtype=float)

        candidates_array = np.array(candidates)
        # Remove near-duplicates (floating point)
        return np.unique(np.round(candidates_array, decimals=6), axis=0)

    def split_long_edges_with_coords(
            self,
            mst: nx.DiGraph,
            nodes: List,
            max_length_m: float = 30.0,
            min_segment_length: float = 15.0,
    ) -> Tuple[nx.DiGraph, List]:
        """
        Break long edges (> max_length_m meters) into multiple shorter segments by
        inserting new intermediate pole nodes along the straight line between endpoints.

        Args:
            mst: The current minimum spanning arborescence (directed graph)
            nodes: Current list of Node objects (will be extended with new poles)
            max_length_m: Edges longer than this are fragmented (default: 30m)
            min_segment_length: Don't create segments shorter than this (safety)

        Returns:
            (updated_mst, updated_nodes)
        """
        # We'll build a new graph and extend the nodes list
        new_mst = nx.DiGraph()
        new_nodes = nodes.copy()  # shallow copy — we'll append new Node objects

        # Quick lookup: index → Node
        node_by_index = {n.index: n for n in new_nodes}

        # Keep track of the highest index used so far
        next_index = max(n.index for n in new_nodes) + 1



        # Copy all short edges directly + fragment long ones
        for u, v, data in list(mst.edges(data=True)):
            length_m = data.get("length", 0.0)
            voltage = data.get("voltage", "unknown")

            if abs(length_m - max_length_m) < 2:
                # Short enough → copy edge as-is
                new_mst.add_edge(u, v, **data)
                continue

            # Long edge → fragment
            start_node = node_by_index[u]
            end_node = node_by_index[v]

            start_coord = np.array([start_node.lat, start_node.lng])
            end_coord = np.array([end_node.lat, end_node.lng])

            # Direction vector
            direction = end_coord - start_coord
            total_length = length_m  # already in meters

            # How many full segments do we want?
            num_segments = max(2, int(np.floor(total_length / max_length_m)))
            segment_length = total_length / num_segments

            if segment_length < min_segment_length:
                # Edge is long but segments would be too small → just leave it
                # (or you could force at least 2 segments — decide policy)
                new_mst.add_edge(u, v, **data)
                continue

            # We'll create (num_segments - 1) new intermediate nodes
            current = start_coord.copy()
            prev_idx = u

            for i in range(1, num_segments):
                # Move along the line
                fraction = i / num_segments
                current = start_coord + fraction * direction

                # Create new pole node
                new_node = Node(
                    index=next_index,
                    lat=float(current[0]),
                    lng=float(current[1]),
                    type="pole",
                    name=None,  # will be named later if used
                    is_candidate=True,
                    used=True,  # since it's going into the tree
                )
                new_nodes.append(new_node)
                node_by_index[next_index] = new_node

                # Connect previous → new
                new_mst.add_edge(
                    prev_idx,
                    next_index,
                    length=segment_length,
                    voltage=voltage,
                    weight=self.calc_edge_weight(segment_length, voltage=voltage, pole=True)
                )

                prev_idx = next_index
                next_index += 1

            # Final segment: last intermediate → original end
            new_mst.add_edge(
                prev_idx,
                v,
                length=segment_length,
                voltage=voltage,
                weight=self.calc_edge_weight(segment_length, voltage=voltage, pole=True),
            )

        # Optional: copy graph-level attributes if any exist
        new_mst.graph.update(mst.graph)

        return new_mst, new_nodes

    def generate_voronoi_candidates(self, coords: np.ndarray) -> np.ndarray:
        """
        Generates candidate pole locations from Voronoi vertices with filtering.
        Final step: removes candidates closer than MIN_CANDIDATE_SEPARATION meters.
        """

        if len(coords) < 3:
            return np.empty((0, 2), dtype=float)

        vor = Voronoi(coords)
        if len(vor.vertices) == 0:
            return np.empty((0, 2), dtype=float)

        verts = vor.vertices  # shape (n_vertices, 2)

        # Vectorized haversine distances from vertices to original points
        dists = self.haversine_vec(verts, coords)  # assume you have this function

        nearest_dists = np.partition(dists, 2, axis=1)[:, :3]
        min_dists = nearest_dists[:, 0]
        third_min_dists = nearest_dists[:, 2]

        mask = min_dists >= MIN_DIST_TO_TERMINAL

        if MAX_CIRCUMRADIUS is not None:
            mask &= (third_min_dists <= MAX_CIRCUMRADIUS)

        candidates = verts[mask]

        if len(candidates) == 0:
            if self.request.debug >= 1:
                print("No Voronoi candidates after initial filtering")
            return candidates

        # ─── Step 1: Deduplicate with rounding (existing) ───────────────────────
        candidates = np.unique(np.round(candidates, decimals=6), axis=0)

        if len(candidates) <= 1:
            if self.request.debug >= 1:
                print(f"Generated {len(candidates)} unique Voronoi candidate poles")
            return candidates

        # ─── Step 2: Enforce minimum separation (new) ───────────────────────────
        # Sort by latitude for somewhat spatial order (helps greedy algorithm)
        sort_idx = np.argsort(candidates[:, 0])
        candidates = candidates[sort_idx]

        # Greedy filter: keep point only if >= MIN distance from all kept points
        kept = []
        kept_array = np.empty((0, 2))

        for pt in candidates:
            if len(kept_array) == 0:
                kept.append(pt)
                kept_array = np.array([pt])
                continue

            # Compute distances to already kept points
            dists_to_kept = self.haversine_vec(np.array([pt]), kept_array)[0]

            if np.all(dists_to_kept >= MIN_CANDIDATE_SEPARATION):
                kept.append(pt)
                kept_array = np.vstack([kept_array, pt])

        candidates = np.array(kept)

        if self.request.debug >= 1:
            print(f"Generated {len(candidates)} Voronoi candidate poles "
                  f"after min {MIN_CANDIDATE_SEPARATION}m separation filter "
                  f"(from {len(vor.vertices)} vertices)")

        return candidates

    def fermat_torricelli_point(self, pts: np.ndarray) -> np.ndarray:
        """
        Compute approximate Fermat-Torricelli point for a triangle (3 points).
        If any angle ≥ 120°, returns the vertex with that angle.
        Otherwise returns a rough approximation (centroid fallback for simplicity).
        """
        if len(pts) != 3:
            raise ValueError("Need exactly 3 points")

        A, B, C = pts

        # Compute side lengths
        a = np.linalg.norm(B - C)
        b = np.linalg.norm(A - C)
        c = np.linalg.norm(A - B)

        # Cosines of angles
        cosA = (b ** 2 + c ** 2 - a ** 2) / (2 * b * c) if b * c != 0 else 1
        cosB = (a ** 2 + c ** 2 - b ** 2) / (2 * a * c) if a * c != 0 else 1
        cosC = (a ** 2 + b ** 2 - c ** 2) / (2 * a * b) if a * b != 0 else 1

        # If any angle ≥ 120° (cos ≤ -0.5), minimum is at that vertex
        if cosA <= -0.5:
            return A
        if cosB <= -0.5:
            return B
        if cosC <= -0.5:
            return C

        # Otherwise: simple centroid approximation (good enough for our purpose)
        # (Real 120° construction is more involved — this is fast & reasonable)
        return np.mean(pts, axis=0)

    def generate_fermat_candidates(self, coords: np.ndarray, max_candidates: int = 30) -> np.ndarray:
        """
        Generate candidate pole locations using approximate Fermat-Torricelli points
        from Delaunay triangles. These are more "Steiner-like" than Voronoi vertices.

        Args:
            coords: (n, 2) array of terminal points [lat, lon]
            max_candidates: limit number of generated points (avoid too many)

        Returns:
            np.ndarray: candidate points (m, 2)
        """
        if len(coords) < 3:
            return np.empty((0, 2), dtype=float)

        # Compute Delaunay triangulation
        tri = Delaunay(coords)

        candidates = []

        for simplex in tri.simplices:
            if len(candidates) >= max_candidates:
                break
            pts = coords[simplex]
            # Get approximate Steiner/Fermat point for this triangle
            st_pt = self.fermat_torricelli_point(pts)
            candidates.append(st_pt)

        if not candidates:
            return np.empty((0, 2), dtype=float)

        candidates = np.array(candidates)

        # mask candidates too close to terminals
        mask = (CandidateMSTSolver.haversine_vec(candidates, coords) >= MIN_DIST_TO_TERMINAL).prod(axis=1)

        candidates = candidates[mask]

        print(f"Generated {len(candidates)} Fermat-Steiner candidate poles "
              f"(limited to {max_candidates}, after min separation filter)")

        return candidates

    def filter_candidates_by_buildings(
            self,
            candidates: Union[np.ndarray, list[tuple[float, float]]],
            coords: Union[np.ndarray, list[tuple[float, float]]],
            padding_deg: float = 0.0001  # tiny buffer ~11 m at equator
    ) -> np.ndarray:
        """
        1. Compute bounding box from candidates (with small padding)
        2. Keep only buildings whose CENTROID is INSIDE that bounding box
        3. Parse geometry → shapely Polygon for those buildings only
        4. Remove candidates that lie inside any of those building polygons

        Returns filtered candidates as numpy array (n, 2)
        """
        coords = np.asarray(coords)
        if coords.ndim != 2 or coords.shape[1] != 2:
            raise ValueError("coords must be (n, 2) [[lat, lon], ...]")

        if len(coords) == 0:
            return coords

        # ─── 1. Bounding box from coords ────────────────────────────────
        min_lat = np.min(coords[:, 0])
        max_lat = np.max(coords[:, 0])
        min_lon = np.min(coords[:, 1])
        max_lon = np.max(coords[:, 1])

        # Optional small padding so buildings exactly on the edge are included
        min_lat -= padding_deg
        max_lat += padding_deg
        min_lon -= padding_deg
        max_lon += padding_deg

        print(f"Candidates bbox (padded): "
              f"lat [{min_lat:.8f}, {max_lat:.8f}], "
              f"lon [{min_lon:.8f}, {max_lon:.8f}]")

        # ─── 2. Load CSV and filter buildings by centroid inside bbox ────────
        df = pd.read_csv("179_buildings.csv", usecols=['latitude', 'longitude', 'geometry'])

        # Drop rows missing required columns
        df = df.dropna(subset=['latitude', 'longitude', 'geometry'])

        # Keep only buildings whose centroid is inside the bbox
        inside_mask = (
                (df['latitude'] >= min_lat) & (df['latitude'] <= max_lat) &
                (df['longitude'] >= min_lon) & (df['longitude'] <= max_lon)
        )

        df_filtered = df[inside_mask].copy()

        if df_filtered.empty:
            print("No building centroids inside coords bbox → all candidates kept")
            return candidates

        print(f"Found {len(df_filtered)} buildings with centroid inside bbox")

        # ─── 3. Parse geometry for the filtered buildings only ───────────────
        df_filtered['poly'] = df_filtered['geometry'].apply(loads)

        # Drop invalid geometries
        df_filtered = df_filtered[df_filtered['poly'].apply(lambda g: g.is_valid if g else False)]

        if df_filtered.empty:
            print("No valid building polygons after filtering → all candidates kept")
            return candidates

        # ─── 4. Remove candidates inside any remaining building polygon ──────
        polygons = df_filtered['poly'].values

        def is_covered(lat: float, lon: float) -> bool:
            pt = Point(lon, lat)  # shapely uses (x=lon, y=lat)
            for poly in polygons:
                if poly.contains(pt):
                    return True
            return False

        # Vectorized-ish check (still loop, but only over relevant buildings)
        keep_mask = np.ones(len(candidates), dtype=bool)
        for i, (lat, lon) in enumerate(candidates):
            if is_covered(lat, lon):
                keep_mask[i] = False

        filtered = candidates[keep_mask]

        removed = len(candidates) - len(filtered)
        removed_nodes = [c for c in candidates if c not in filtered]
        if removed > 0:
            print(f"Removed {removed} candidates inside building footprints: {removed_nodes}")

        return filtered

    def _solve(self, input_tuple) -> Tuple[nx.DiGraph, List[Node], np.ndarray]:
        """
        Solves the problem by processing candidate points, building a graph, and computing a
        minimum spanning arborescence (MST) before postprocessing the result.

        Args:
            input_tuple: A tuple containing the parsed input data


        Returns:
            SolverResult: The result containing details such as edges, node information,
            and computed metrics including lengths and count of used poles.

        Raises:
            ValueError: If an unsupported candidate algorithm is specified.
        """
        nodes, coords, source_idx, terminal_indices, names, costs = input_tuple

        # 1. Candidates
        if self.candidate_algorithm == 'voronoi':
            candidates = self.generate_voronoi_candidates(coords)
        elif self.candidate_algorithm == 'fermat':
            candidates = self.generate_fermat_candidates(coords, max_candidates=100)
        else:
            raise ValueError(f"Unsupported candidate algorithm: {self.candidate_algorithm}")

        # 2. Build unified nodes
        nodes = self._build_nodes(coords, candidates, source_idx, terminal_indices, names)

        # 3. Distance matrix
        all_points = np.array([n.coord_tuple for n in nodes])
        dist_matrix = self.compute_distance_matrix(all_points)

        pole_indices = [n.index for n in nodes if n.type == "pole"]

        # 4. Graph + arborescence
        DG = self.build_directed_graph_for_arborescence(
            source_idx=source_idx,
            terminal_indices=terminal_indices,
            pole_indices=pole_indices,
            dist_matrix=dist_matrix,
        )

        arbo = nx.minimum_spanning_arborescence(DG, attr="weight", default=1e18, preserve_attrs=True)

        # 5. Prune
        mst = self.prune_dead_end_pole_branches(arbo, pole_indices, terminal_indices)

        # 6. break long line segments
        mst, nodes = self.split_long_edges_with_coords(
            mst=mst,
            nodes=nodes,
            max_length_m=30.0,
            min_segment_length=5.0,
        )

        return mst, nodes, coords
