# src/solvers/simple_mst_solver.py
import networkx as nx
import numpy as np
from matplotlib import collections as mc
from matplotlib import pyplot as plt
from sklearn.cluster import KMeans

from .candidate_mst_solver import CandidateMSTSolver, MAX_POLE_TO_POLE_LV
from .registry import register_solver
from ..utils.models import SolverResult

DEBUG = 0


@register_solver
class IteratedOneSteinerSolver(CandidateMSTSolver):
    """
    Solver class for iteratively finding an optimized minimum spanning tree (MST)
    or arborescence using candidate Steiner point additions.

    This class extends the CandidateMSTSolver to apply iterative refinement via
    Steiner point insertion and reevaluation of MST/arborescence solutions. It
    includes visualization utilities, graph construction for arborescence, and a
    solve method to perform multiple iterations based on candidate generation.
    """

    def _plot_current_tree(
            self,
            nodes_list,  # List[Node]
            mst_or_arbo,  # nx.Graph / nx.DiGraph
            added_point=None,  # optional: the newly added candidate coord (tuple/list)
            title="Current tree after candidate addition",
            filename=None  # if given → save to file instead of show
    ):
        fig, ax = plt.subplots(figsize=(10, 8))
        ax.set_title(title)
        ax.set_xlabel("Longitude")
        ax.set_ylabel("Latitude")
        ax.set_aspect('equal')

        # 1. Safely map indices to their true coordinates
        coord_dict = {n.index: n.coord_tuple for n in nodes_list}

        # 2. Extract specific coordinates by type
        source_coords = [n.coord_tuple for n in nodes_list if n.type == "source"]
        term_coords = [n.coord_tuple for n in nodes_list if n.type == "terminal"]
        pole_coords = [n.coord_tuple for n in nodes_list if n.type == "pole"]

        # Plot Source
        if source_coords:
            sc = np.array(source_coords)
            ax.scatter(sc[:, 1], sc[:, 0], c='blue', s=120, marker='s', label='Source')

        # Plot Terminals
        if term_coords:
            tc = np.array(term_coords)
            ax.scatter(tc[:, 1], tc[:, 0], c='red', s=80, marker='o', label='Terminals')

        # Plot Existing poles
        if pole_coords:
            pc = np.array(pole_coords)
            ax.scatter(pc[:, 1], pc[:, 0], c='black', s=60, marker='^', label='Poles')

        # Highlight newly added candidate
        if added_point is not None:
            ax.scatter(added_point[1], added_point[0], c='orange', s=200, marker='*', edgecolor='black', linewidth=1.5,
                       label='Newly added pole')

        # Plot edges
        edge_lines = []
        for u, v in mst_or_arbo.edges():
            # Safely look up the exact coordinate using the node's unique index
            if u in coord_dict and v in coord_dict:
                pt_u = [coord_dict[u][1], coord_dict[u][0]]  # [lng, lat]
                pt_v = [coord_dict[v][1], coord_dict[v][0]]
                edge_lines.append([pt_u, pt_v])

        if edge_lines:
            lc = mc.LineCollection(edge_lines, colors='green', linewidths=1.5, alpha=0.7)
            ax.add_collection(lc)

        ax.legend(loc='upper right', fontsize=9)
        ax.grid(True, alpha=0.3)

        if filename:
            plt.savefig(filename, dpi=150, bbox_inches='tight')
            plt.close(fig)
            print(f"Saved plot: {filename}")
        else:
            plt.show()
            plt.close(fig)

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

        if DEBUG >= 1:
            # plot centers
            fig, ax = plt.subplots(figsize=(10, 8))
            ax.set_title(f"K-Means Cluster Centers (k={k})")
            ax.set_xlabel("Longitude")
            ax.set_ylabel("Latitude")
            ax.set_aspect('equal')
            ax.scatter(cluster_centers[:, 1], cluster_centers[:, 0], c='black', s=100, marker='o',
                       label='Cluster centers')
            ax.legend(loc='upper right', fontsize=9)
            ax.grid(True, alpha=0.3)
            plt.show()
            plt.close(fig)

        return cluster_centers

    def generate_proximity_fermat_candidates(
            self,
            coords: np.ndarray,
            max_distance: float = 60.0,
            max_candidates: int = 300
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

        print(f"Generated {len(candidates)} Fermat-Steiner candidates from proximity triplets "
              f"(max_dist={max_distance}m)")

        return candidates

    def generate_candidates(self,
                            coords,
                            cur_edges,
                            terminal_cluster_centers,
                            added_candidates,
                            max_length=MAX_POLE_TO_POLE_LV, num_per_edge=2):
        # Generate candidates based on current points
        voronoi_candidates = self.generate_voronoi_candidates(np.array(coords))
        fermat_candidates = self.generate_proximity_fermat_candidates(np.array(coords), max_candidates=100)
        # candidates =fermat_candidates
        # candidates = np.empty((0, 2))
        candidates = np.concatenate([voronoi_candidates, fermat_candidates], axis=0)

        if cur_edges is not None:
            collinear_candidates = self.generate_collinear_candidates(np.array(coords), cur_edges,
                                                                      max_length=max_length, num_per_edge=num_per_edge)
            if len(collinear_candidates) > 0:
                candidates = np.concatenate([candidates, collinear_candidates], axis=0)

        # remove candidates outside of bounding box
        coords_bb = self.compute_bounding_box(coords)
        lat_mask = (coords_bb['min_lat'] <= candidates[:, 0]) * (candidates[:, 0] <= coords_bb['max_lat'])
        lng_mask = (coords_bb['min_lng'] <= candidates[:, 1]) * (candidates[:, 1] <= coords_bb['max_lng'])
        mask = lat_mask * lng_mask
        candidates = candidates[mask]

        candidates = np.concatenate([candidates, terminal_cluster_centers], axis=0)

        # remove candidates already added
        ac = [tuple(c) for c in added_candidates]
        candidates = np.array([c for c in candidates if tuple(c) not in ac])

        candidates = np.unique(candidates, axis=0)

        if DEBUG >= 1 and len(candidates) > 0:
            # plots candidates
            fig, ax = plt.subplots(figsize=(10, 8))
            ax.set_title("Generated Candidates")
            ax.set_xlabel("Longitude")
            ax.set_ylabel("Latitude")
            ax.set_aspect('equal')
            ax.scatter(candidates[:, 1], candidates[:, 0], c='black', s=100, marker='o', label='Candidates')
            ax.legend(loc='upper right', fontsize=9)
            ax.grid(True, alpha=0.3)
            plt.show()

        return candidates

    def solve(self) -> SolverResult:
        """
        Executes an iterative algorithm to optimize network topology, introducing new points (poles)
        to minimize the cost and maximize the efficiency of the resulting graph, evaluated using
        Minimum Spanning Tree and related techniques. The method incorporates multiple candidate
        generation strategies like Voronoi and Fermat points to identify potential new locations
        to add to the network, and iteratively improves the network structure until stagnation or
        a convergence criteria is met.

        Returns:
            SolverResult: The final optimized result, including the list of edges, used nodes,
            total lengths for low and high voltage components, number of poles, and optionally
            debug information.

        Raises:
            Exception: Handles and suppresses errors during candidate evaluation, ensuring robust
            iteration through all valid candidates without halting the process. Any exceptions
            encountered during graph construction or candidate validation are logged.

        Attributes:
            coord (list): List of [latitude, longitude] or [longitude, latitude] coordinates,
                depending on the indexing used. It represents the current node positions.
            source_idx (int): Index of the source node in the network topology.
            terminal_indices (list[int]): A list of indices representing terminal nodes in the
                network infrastructure.
            names (list[str]): The names of the nodes, initially populated with existing nodes
                and expanded during the addition of new candidates (e.g., poles).
            costs (Any): Represents the cost parameters or weight metrics involved in determining
                the optimal network construction.
            cur_total_weight (float): Tracks the total weight or cost of the current network
                configuration.
            cur_edges (Any): Holds the edges of the current spanning tree or network structure.
            DEBUG (int): Configurable debug level controlling verbosity and intermediate output
                visualization, if enabled.

        Note:
            - The method internally utilizes helper functions and sub-procedures for tasks like
              candidate generation, MST calculation, and pruning operations.
            - The algorithm may incorporate small controlled deteriorations (e.g., <1% worsening
              in cost) to escape local minima or plateaus in the optimization landscape.
            - Debugging tools and plotting utilities are conditionally executed, based on the provided
              debug configuration.
        """
        nodes, coords, source_idx, terminal_indices, names, costs = self.parse_and_validate_input()

        # We'll keep coords as list for easier appending
        current_coords = list(coords)  # list of [lat, lng] or [lng, lat] – adjust indexing accordingly
        current_names = list(names)

        added_candidates = []
        iteration = 0

        cur_total_weight = np.inf
        cur_edges = None

        terminal_cluster_centers = self.generate_cluster_center_candidates(np.array(coords),
                                                                           min_clusters=2,
                                                                           max_clusters=12,
                                                                           n_init=5)  # lower n_init for speed

        while True:
            iteration += 1
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
            best_candidate = None
            best_pruned_mst = None
            best_nodes = None
            best_edges = None

            for c in candidates:

                # Build temporary point set with this candidate
                trial_coords = np.vstack([current_coords, c])
                trial_names = current_names

                trial_nodes = self._build_nodes(np.array(current_coords), [c], source_idx, terminal_indices,
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

                if DEBUG >= 2:
                    self._plot_current_tree(
                        trial_nodes,
                        pruned,
                        added_point=c,
                        title=f"Debug {c}",
                        filename=None
                    )

                if total_cost < best_cost:
                    best_cost = total_cost
                    best_max_edge = max(pruned.get_edge_data(*e)["length"] for e in pruned.edges())
                    best_candidate = c
                    best_pruned_mst = pruned
                    best_nodes = trial_nodes
                    best_edges = pruned.edges()

            # ─── Decide whether to accept ──────────────────────────────────────
            if best_cost >= cur_total_weight:  # allow tiny worsening to escape plateaus if needed
                print("No meaningful improvement found → stopping")
                break

            # Accept the winner
            print(
                f"→ Adding candidate {best_candidate} → new length: {best_cost:.2f} m (max edge: {best_max_edge:.2f} m)")

            # set current coordinates
            added_candidates.append(tuple(best_candidate))
            current_coords = np.vstack([current_coords, best_candidate])
            current_names.append("pole")

            cur_total_weight = best_cost
            cur_edges = best_edges

            # ─── PLOT THE WINNING STATE AFTER ADDITION ─────────────────────────
            if DEBUG >= 2:
                plot_title = f"Iteration {iteration} – Added pole at {best_candidate} (length: {best_cost:.1f} m)"

                self._plot_current_tree(
                    best_nodes,
                    best_pruned_mst,
                    added_point=best_candidate,
                    title=plot_title,
                    filename=None
                )

        if DEBUG >= 1:
            self._plot_current_tree(
                best_nodes,
                best_pruned_mst,
                title="Split MST before Drop Phase",
                added_point=None,
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
            min_segment_length=25.0
        )

        # 6. Mark used & name poles
        used_nodes = self.extract_used_nodes(best_pruned_mst, nodes)

        # 7. Build edges + lengths
        edges, total_low_m, total_high_m = self._build_edges_and_lengths(best_pruned_mst, used_nodes)

        num_poles = sum(1 for n in used_nodes if n.type == "pole")

        if DEBUG >= 1:
            print(max([l.lengthMeters for l in edges]))
            self._plot_current_tree(
                used_nodes,
                best_pruned_mst,
                title="Best Final Plot",
            )

        debug = {
            "method": "classic_mst_fermat",
            "candidates_generated": len(candidates),
            "candidates_used": num_poles,
            "original_points": len(coords),
        } if self.request.debug else None

        return self.build_simple_result(
            edges=edges,
            used_nodes=used_nodes,
            total_low_m=total_low_m,
            total_high_m=total_high_m,
            num_poles=num_poles,
            debug_info=debug,
        )
