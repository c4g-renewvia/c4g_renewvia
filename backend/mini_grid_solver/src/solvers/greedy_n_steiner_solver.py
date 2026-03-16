# src/solvers/simple_mst_solver.py
import itertools
from typing import Tuple, List

import networkx as nx
import numpy as np
from matplotlib import pyplot as plt
from sklearn.cluster import KMeans

from .candidate_mst_solver import CandidateMSTSolver, MAX_POLE_TO_POLE_LV
from .registry import register_solver
from ..utils.models import SolverRequest, Node


@register_solver
class GreedyNSteinerSolver(CandidateMSTSolver):
    """
    Solver class for iteratively finding an optimized minimum spanning tree (MST)
    or arborescence using candidate Steiner point additions.

    This class extends the CandidateMSTSolver to apply iterative refinement via
    Steiner point insertion and reevaluation of MST/arborescence solutions. It
    includes visualization utilities, graph construction for arborescence, and a
    solve method to perform multiple iterations based on candidate generation.

    Args:
        n: number of greedy candidates to evaluate per iteration (default: 1).
            This controls how many of the generated candidates are evaluated in each iteration.
            Setting n=1 means only the single best candidate (lowest cost)
    """

    def __init__(self, request: SolverRequest):
        super().__init__(request)
        self.n = int(request.params.get("n", 1))

    @staticmethod
    def get_input_params():
        return [
            {
                "name": "n",
                "type": "integer",
                "default": 1,
                "min": 1,
                "max": 3,
                "description": "Maximum Number of greedy candidates to evaluate per iteration."

            }
        ]

    def generate_projection_candidates(
            self,
            coords_array,  # np.array (n_total, 2) current points [lat, lng]
            edge_list,  # list of (u_idx, v_idx) from current tree
            terminal_indices,  # original terminal indices (fixed)
            max_dist_to_line=40.0,  # meters — how close a terminal must be to the line
            min_dist_to_existing=5.0  # avoid adding very close to existing points
    ):
        """
        Project nearby terminals onto current edges to create T-junction candidates.
        """
        candidates = []

        def point_to_segment_distance_and_projection(p, a, b):
            """Return distance from point p to segment [a,b] and closest point on segment."""
            # Vector math (all in lat/lng — approximate for small areas)
            ab = b - a
            ap = p - a
            proj = np.dot(ap, ab) / np.dot(ab, ab)
            proj = np.clip(proj, 0.0, 1.0)
            closest = a + proj * ab

            dist_to_closest = self.haversine_meters(p[0], p[1], closest[0], closest[1])
            return dist_to_closest, closest

        for u, v in edge_list:
            a = coords_array[u]
            b = coords_array[v]

            for h_idx in terminal_indices:
                h = coords_array[h_idx]
                dist, proj_point = point_to_segment_distance_and_projection(h, a, b)

                if dist <= max_dist_to_line:
                    # Check not too close to existing points
                    dists_to_existing = np.min(
                        self.haversine_vec(np.array([proj_point]), coords_array)
                    )
                    if dists_to_existing >= min_dist_to_existing:
                        candidates.append(proj_point)

        if not candidates:
            return np.array([])

        projs = np.array(candidates)
        projs = np.unique(np.round(projs, decimals=6), axis=0)  # dedup

        return projs

    def generate_cluster_center_candidates(self, coords, min_clusters=2, max_clusters=15, n_init=10):
        """
        Generate candidate pole locations as centers of K-Means clusters.

        - Tries multiple k values and takes all unique centers
        - Filters very small clusters (e.g. < 3 points)
        """
        if len(coords) < 6:
            return np.array([])  # too few points → no meaningful clusters

        candidates = []
        coords_array = np.array(coords)  # shape (n, 2) [lat, lng] or [lng, lat]

        print(len(coords) // 3)

        for k in range(len(coords) // 2, len(coords) // 2 + 2):
            try:
                kmeans = KMeans(n_clusters=k, n_init=n_init, random_state=42)
                kmeans.fit(coords_array)
                centers = kmeans.cluster_centers_

                # Optional: only keep centers of clusters with >= min_points
                labels, counts = np.unique(kmeans.labels_, return_counts=True)
                valid_centers = centers[counts >= 2]  # at least  points per cluster

                candidates.extend(valid_centers)
            except Exception as e:
                print(f"K-Means k={k} failed: {e}")
                continue

        if not candidates:
            return np.array([])

        cluster_centers = np.array(candidates)

        # Deduplicate (very close centers from different k)
        cluster_centers = np.unique(np.round(cluster_centers, decimals=6), axis=0)

        return cluster_centers

    def generate_proximity_fermat_candidates(
            self,
            coords: np.ndarray,
            max_distance: float = 60.0,
            max_candidates: int = 300,
    ) -> np.ndarray:
        """
        Generate candidate pole locations using approximate Fermat-Torricelli points
        for ANY triplet of nodes where all three nodes are within `max_distance` of each other.
        """
        n = len(coords)
        if n < 3:
            return np.empty((0, 2), dtype=float)

        # 1. Precompute a localized distance matrix for the coordinates
        # We do this here because this is called before the main dist_matrix is built
        dist_matrix = np.zeros((n, n))
        for i in range(n):
            for j in range(i + 1, n):
                # Using the haversine_meters function already in your class
                d = self.haversine_meters(coords[i, 0], coords[i, 1], coords[j, 0], coords[j, 1])
                dist_matrix[i, j] = d
                dist_matrix[j, i] = d

        candidates = []

        # 2. Find all valid triplets (i, j, k) where all pairwise distances are <= max_distance
        # We use strict combinations (i < j < k) to avoid permutations of the same triangle
        for i in range(n):
            for j in range(i + 1, n):
                if dist_matrix[i, j] > max_distance:
                    continue  # Skip early if i and j are already too far apart

                for k in range(j + 1, n):
                    # Check if k is close to BOTH i and j
                    if dist_matrix[i, k] <= max_distance and dist_matrix[j, k] <= max_distance:
                        pts = np.array([coords[i], coords[j], coords[k]])

                        # Use your existing fermat calculation
                        st_pt = self.fermat_torricelli_point(pts)
                        candidates.append(st_pt)

                        if len(candidates) >= max_candidates:
                            break
                if len(candidates) >= max_candidates:
                    break
            if len(candidates) >= max_candidates:
                break

        if not candidates:
            return np.empty((0, 2), dtype=float)

        candidates = np.array(candidates)

        # 3. Filter candidates that are too close to existing terminals
        # (Enforcing MIN_DIST_TO_TERMINAL, assuming it's 10.0m)
        valid_candidates = []
        for cand in candidates:
            # Check the minimum distance to any original coordinate
            min_d = min(self.haversine_meters(cand[0], cand[1], c[0], c[1]) for c in coords)
            if min_d >= 10.0:
                valid_candidates.append(cand)

        candidates = np.array(valid_candidates)

        # 4. Deduplicate close overlapping candidates
        if len(candidates) > 0:
            candidates = np.unique(np.round(candidates, decimals=6), axis=0)

        if self.request.debug >= 1:
            print(f"Generated {len(candidates)} Fermat-Steiner candidates from proximity triplets "
                  f"(max_dist={max_distance}m)")

        return candidates

    def generate_candidates(self,
                            coords,
                            cur_edges,
                            terminal_cluster_centers,
                            added_candidates,
                            max_length=MAX_POLE_TO_POLE_LV, num_per_edge=2):

        # remove candidates outside of terminal bounding box
        def mask_outside_terminal_bb(coords, cands):
            coords_bb = self.compute_bounding_box(coords)
            lat_mask = (coords_bb['min_lat'] <= cands[:, 0]) * (cands[:, 0] <= coords_bb['max_lat'])
            lng_mask = (coords_bb['min_lng'] <= cands[:, 1]) * (cands[:, 1] <= coords_bb['max_lng'])
            mask = lat_mask * lng_mask
            cands = cands[mask]
            return cands

        # Generate candidates based on current points
        voronoi_candidates = self.generate_voronoi_candidates(np.array(coords))
        voronoi_candidates = mask_outside_terminal_bb(coords, voronoi_candidates)
        fermat_candidates = self.generate_proximity_fermat_candidates(np.array(coords), max_candidates=100)
        fermat_candidates = mask_outside_terminal_bb(coords, fermat_candidates)

        # candidates =fermat_candidates
        # candidates = np.empty((0, 2))
        candidates = np.concatenate([voronoi_candidates, fermat_candidates], axis=0)

        if cur_edges is not None:
            collinear_candidates = self.generate_collinear_candidates(np.array(coords),
                                                                      cur_edges,
                                                                      max_length=max_length,
                                                                      num_per_edge=num_per_edge)

            # add terminal projections onto existing edges
            projection_candidates = self.generate_projection_candidates(
                np.array(coords),
                cur_edges,
                terminal_indices=self._terminal_indices,  # pass from class or solve
                max_dist_to_line=40.0,
                min_dist_to_existing=5.0
            )
        else:
            projection_candidates = np.empty((0, 2))
            collinear_candidates = np.empty((0, 2))

        # add projection candidates
        if len(projection_candidates) > 0:
            projection_candidates = mask_outside_terminal_bb(coords, projection_candidates)
            candidates = np.concatenate([candidates, projection_candidates], axis=0)

        # add collinear candidates
        if len(collinear_candidates) > 0:
            collinear_candidates = mask_outside_terminal_bb(coords, collinear_candidates)
            candidates = np.concatenate([candidates, collinear_candidates], axis=0)

        # add terminal cluster centers
        if len(terminal_cluster_centers) > 0:
            terminal_cluster_centers = mask_outside_terminal_bb(coords, terminal_cluster_centers)
            candidates = np.concatenate([candidates, terminal_cluster_centers], axis=0)

        # -------------- FILTER CANDIDATES --------------
        # remove candidates already added
        ac = [tuple(c) for c in added_candidates]
        candidates = np.array([c for c in candidates if tuple(c) not in ac])

        # dedupe
        candidates = np.unique(candidates, axis=0)

        if self.request.debug >= 1 and len(candidates) > 0:
            # plots candidates
            fig, ax = plt.subplots(figsize=(10, 8))
            ax.set_title("Generated Candidates")
            ax.set_xlabel("Longitude")
            ax.set_ylabel("Latitude")
            ax.set_aspect('equal')
            ax.scatter(voronoi_candidates[:, 1], voronoi_candidates[:, 0], s=100, marker='o',
                       label='Voronoi Candidates')
            ax.scatter(fermat_candidates[:, 1], fermat_candidates[:, 0], s=100, marker='o', label='Fermat Candidates')
            ax.scatter(collinear_candidates[:, 1], collinear_candidates[:, 0], s=100, marker='o',
                       label='Collinear Candidates')
            ax.scatter(projection_candidates[:, 1], projection_candidates[:, 0], s=100, marker='o',
                       label='Projection Candidates')
            ax.scatter(terminal_cluster_centers[:, 1], terminal_cluster_centers[:, 0], s=100, marker='o',
                       label='Cluster Candidates')
            ax.scatter(coords[:, 1], coords[:, 0], c='black', s=100, marker='o', label='Existing Points')
            ax.legend(fontsize=9)
            ax.grid(True, alpha=0.3)
            plt.show()

        return candidates

    def _solve(self, input_tuple) -> Tuple[nx.DiGraph, List[Node], np.ndarray]:
        """
        Solves the optimization problem of constructing the minimum spanning arborescence with additional candidate nodes
        from an initial set of nodes and edges. The algorithm iteratively improves upon the solution by adding and pruning
        nodes efficiently to minimize total weight.

        Args:
            input_tuple (Tuple): A tuple containing the following parameters:
                - nodes (Iterable): Initial nodes of the graph.
                - coords (np.ndarray): Coordinates of the nodes.
                - source_idx (int): Index of the source node in the graph.
                - terminal_indices (List[int]): Indices of the terminal nodes.
                - names (List[str]): List of node names corresponding to `coords`.
                - costs (np.ndarray): Cost matrix used for the spanning arborescence calculation.

        Returns:
            Tuple[nx.DiGraph, List[Node], np.ndarray]: A tuple containing:
                - Directed graph representing the optimized spanning arborescence.
                - List of Node objects based on the optimized graph.
                - Numpy array of the final coordinate set including additional nodes.

        """
        nodes, coords, source_idx, terminal_indices, names, costs = input_tuple

        # We'll keep coords as list for easier appending
        current_coords = list(coords)  # list of [lat, lng] or [lng, lat] – adjust indexing accordingly
        current_names = list(names)

        added_candidates = np.empty([0, 2])
        iteration = 0

        cur_total_weight = np.inf
        cur_edges = None

        terminal_cluster_centers = self.generate_cluster_center_candidates(np.array(coords),
                                                                           min_clusters=2,
                                                                           max_clusters=12,
                                                                           n_init=5)  # lower n_init for speed

        while True:
            iteration += 1
            if self.request.debug >= 1:
                print(f"\nIteration {iteration}")

            # get candidate positions
            candidates = self.generate_candidates(np.array(current_coords),
                                                  cur_edges,
                                                  terminal_cluster_centers,
                                                  added_candidates,
                                                  max_length=MAX_POLE_TO_POLE_LV,
                                                  num_per_edge=3)

            if len(candidates) == 0:
                print("No candidates found")
                break

            best_cost = np.inf
            best_max_edge = 0
            best_candidates = None
            best_pruned_mst = None
            best_nodes = None
            best_edges = None

            # get self.n combinations of candidates
            combinations = []
            for i in range(1, self.n + 1):
                combinations += itertools.combinations(candidates, i)

            if self.request.debug >= 1:
                print(f"Generated {len(combinations)} combinations of {self.n} candidates")

            for cands in combinations:
                cands = np.array(cands)

                # Build temporary point set with this candidate
                trial_coords = np.vstack([current_coords, cands])
                trial_names = current_names + ['pole'] * len(cands)

                trial_nodes = self._build_nodes(np.array(current_coords), cands, source_idx, terminal_indices,
                                                trial_names)
                trial_dist_matrix = self.compute_distance_matrix(trial_coords)

                pole_indices_trial = [n.index for n in trial_nodes if n.type == "pole"]

                DG = self.build_directed_graph_for_arborescence(
                    source_idx, terminal_indices, pole_indices_trial, trial_dist_matrix, costs,
                    max_pole_to_pole_lv=MAX_POLE_TO_POLE_LV,
                    max_pole_to_terminal_lv=MAX_POLE_TO_POLE_LV
                )

                arbo = nx.minimum_spanning_arborescence(DG, attr="weight", default=1e18, preserve_attrs=True)
                pruned = self.prune_dead_end_pole_branches(arbo, pole_indices_trial, terminal_indices)

                total_cost = sum(pruned.get_edge_data(*e)["weight"] for e in pruned.edges())

                if self.request.debug >= 2:
                    self._plot_current_tree(
                        trial_nodes,
                        pruned,
                        added_points=cands,
                        title=f"Debug {cands}",
                        filename=None
                    )

                if total_cost < best_cost:
                    best_cost = total_cost
                    best_max_edge = max(pruned.get_edge_data(*e)["length"] for e in pruned.edges())
                    best_candidates = cands
                    best_pruned_mst = pruned
                    best_nodes = trial_nodes
                    best_edges = pruned.edges()

            # ─── Decide whether to accept ──────────────────────────────────────
            if best_cost >= cur_total_weight:  # allow tiny worsening to escape plateaus if needed
                print("No meaningful improvement found → stopping")
                break

            # Accept the winner
            if self.request.debug >= 1:
                print(f"→ Adding candidate {best_candidates} → "
                      f"new length: {best_cost:.2f} m (max edge: {best_max_edge:.2f} m)")

            # set current coordinates
            added_candidates = np.vstack([added_candidates, best_candidates])
            current_coords = np.vstack([current_coords, best_candidates])
            current_names = current_names + ['pole'] * len(best_candidates)

            cur_total_weight = best_cost
            cur_edges = best_edges

            # ─── PLOT THE WINNING STATE AFTER ADDITION ─────────────────────────
            if self.request.debug >= 1:
                plot_title = f"Iteration {iteration} – Added pole at {best_candidates} (length: {best_cost:.1f} m)"

                self._plot_current_tree(
                    best_nodes,
                    best_pruned_mst,
                    added_points=best_candidates,
                    title=plot_title,
                    filename=None
                )

        if self.request.debug >= 1:
            self._plot_current_tree(
                best_nodes,
                best_pruned_mst,
                title="Split MST before Drop Phase",
                added_points=None,
            )

        # ==========================================
        # DROP PHASE (REVERSE DELETION)
        # ==========================================
        print("\n--- Starting Drop Phase (Reverse Deletion) ---")

        # We need the base original coords to easily rebuild the lists
        original_coords_array = np.array(coords)

        # Iterate in reverse (unwinding the newest additions first)
        candidates_to_check = list(reversed(added_candidates))

        for candidate_to_drop in candidates_to_check:
            # Create a test list of candidates without the current one
            test_added_candidates = [c for c in added_candidates if tuple(c) != tuple(candidate_to_drop)]

            # Build nodes using the original coords and the TEST candidates
            trial_nodes = self._build_nodes(
                original_coords_array,
                test_added_candidates,
                source_idx,
                terminal_indices,
                names  # Original names
            )

            # Reconstruct trial_coords for the distance matrix
            trial_coords = np.array([[n.lat, n.lng] for n in trial_nodes])
            trial_dist_matrix = self.compute_distance_matrix(trial_coords)
            pole_indices_trial = [n.index for n in trial_nodes if n.type == "pole"]

            # Build graph and compute MST
            DG = self.build_directed_graph_for_arborescence(
                source_idx, terminal_indices, pole_indices_trial, trial_dist_matrix, costs,
                max_pole_to_pole_lv=MAX_POLE_TO_POLE_LV,
                max_pole_to_terminal_lv=MAX_POLE_TO_POLE_LV

            )

            arbo = nx.minimum_spanning_arborescence(DG, attr="weight", default=1e18, preserve_attrs=True)
            pruned = self.prune_dead_end_pole_branches(arbo, pole_indices_trial, terminal_indices)

            total_cost = sum(pruned.get_edge_data(*e)["weight"] for e in pruned.edges())

            # If dropping the pole makes the cost LOWER or EXACTLY THE SAME, we drop it!
            # (We prefer fewer poles, so dropping it on a tie is inherently better)
            if total_cost <= cur_total_weight:
                print(
                    f"Drop Phase: Successfully removed redundant pole at {candidate_to_drop}. New cost: {total_cost:.2f}")

                # Permanently update our tracking variables
                added_candidates = test_added_candidates
                cur_total_weight = total_cost
                best_pruned_mst = pruned

                # Update current_coords and current_names to reflect the drop
                # so the rest of your original post-processing works seamlessly
                if added_candidates:
                    current_coords = np.vstack([original_coords_array, added_candidates])
                else:
                    current_coords = original_coords_array
                current_names = list(names) + ["pole"] * len(added_candidates)

        print("--- Drop Phase Complete ---\n")
        # ==========================================

        nodes = self._build_nodes(np.array(current_coords), [], source_idx, terminal_indices, current_names)

        best_pruned_mst, nodes = self.split_long_edges_with_coords(
            mst=best_pruned_mst,
            nodes=nodes,
            max_length_m=MAX_POLE_TO_POLE_LV,
            min_segment_length=20.0
        )

        return best_pruned_mst, nodes, current_coords
