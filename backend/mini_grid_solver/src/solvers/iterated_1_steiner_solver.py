# src/solvers/simple_mst_solver.py
import networkx as nx

from .candidate_mst_solver import CandidateMSTSolver, np, MAX_POLE_TO_POLE_LV, MAX_EDGE_DIST_PENALTY, \
    MAX_POLE_TO_TERMINAL_LV
from .registry import register_solver
from ..utils.models import SolverResult

from matplotlib import pyplot as plt
from matplotlib import collections as mc

LENGTH_PENALTY_MULTIPLIER = 10

DEBUG = 0

@register_solver
class IteratedOneSteinerSolver(CandidateMSTSolver):
    """
    Very simple MST solver that:

    - Uses **only the original points** (no candidate poles)
    - Computes an undirected MST on all points
    - Orients edges away from the source (makes it a tree rooted at source)
    - Assigns all connections as "low voltage" (can be changed later)
    - No fragmentation, no pruning, no extra poles

    Good as a baseline / lower bound reference.
    """

    def _plot_current_tree(
            self,
            nodes_list,  # List[Node]
            mst_or_arbo,  # nx.Graph / nx.DiGraph
            added_point=None,  # optional: the newly added candidate coord (tuple/list)
            title="Current tree after candidate addition",
            filename=None  # if given → save to file instead of show
    ):
        """
        Quick visualization of the current tree state.
        - Blue = source
        - Red = terminals (houses)
        - Black = poles (existing + newly added)
        - Newly added pole = orange star
        - Edges = green lines
        """
        fig, ax = plt.subplots(figsize=(10, 8))
        ax.set_title(title)
        ax.set_xlabel("Longitude")
        ax.set_ylabel("Latitude")
        ax.set_aspect('equal')

        # Extract coordinates
        coords = np.array([n.coord_tuple for n in nodes_list])  # assume .coord_tuple = (lng, lat) or (lat, lng)

        # Plot nodes
        source_idx = [n.index for n in nodes_list if n.type == "source"][0]
        term_indices = [n.index for n in nodes_list if n.type == "terminal"]
        pole_indices = [n.index for n in nodes_list if n.type == "pole"]

        # Source
        ax.scatter(coords[source_idx, 1], coords[source_idx, 0], c='blue', s=120, marker='s', label='Source')

        # Terminals
        ax.scatter(coords[term_indices, 1], coords[term_indices, 0], c='red', s=80, marker='o', label='Terminals')

        # Existing poles
        if pole_indices:
            ax.scatter(coords[pole_indices, 1], coords[pole_indices, 0], c='black', s=60, marker='^', label='Poles')

        # Highlight newly added candidate
        if added_point is not None:
            ax.scatter(added_point[1], added_point[0], c='orange', s=200, marker='*', edgecolor='black', linewidth=1.5,
                       label='Newly added pole')

        # Plot edges
        edge_lines = []
        for u, v in mst_or_arbo.edges():
            pt_u = coords[u, [1, 0]]  # [lng, lat] → [x, y] for plot
            pt_v = coords[v, [1, 0]]
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

    def build_directed_graph_for_arborescence(
            self,
            source_idx,
            terminal_indices,
            pole_indices,
            dist_matrix,
            costs,
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

        # Directed: poles → terminals (service drops)
        for p in pole_indices:
            for h in terminal_indices:
                d = dist_matrix[p, h]
                if 0.1 < d:
                    # cost of wire
                    w = d * low_voltage_cost_per_meter

                    if d > MAX_POLE_TO_TERMINAL_LV:
                        w *= LENGTH_PENALTY_MULTIPLIER

                    DG.add_edge(p, h, weight=w, length=d, voltage="low")

        # dummy self-loop edge for adding the pole cost
        # for p in pole_indices:
        #     DG.add_edge(p, p, weight=pole_cost * 100000, length=0, voltage="low")

        # Bidirectional pole ↔ pole (undirected spans)
        for i in range(len(pole_indices)):
            for j in range(i + 1, len(pole_indices)):
                p1, p2 = pole_indices[i], pole_indices[j]
                d = dist_matrix[p1, p2]
                w = (d * low_voltage_cost_per_meter) + pole_cost
                if d > MAX_POLE_TO_POLE_LV:
                    w *= LENGTH_PENALTY_MULTIPLIER

                if 0.1 < d:
                    DG.add_edge(p1, p2, weight=w, length=d, voltage="low")
                    DG.add_edge(p2, p1, weight=w, length=d, voltage="low")

        # Directed: source → poles (main trunk)
        for p in pole_indices:
            d = dist_matrix[source_idx, p]
            if 0.1 < d:
                w = (d * low_voltage_cost_per_meter) + pole_cost
                if d > MAX_POLE_TO_POLE_LV:
                    w *= LENGTH_PENALTY_MULTIPLIER

                DG.add_edge(source_idx, p, weight=w, length=d, voltage="low")

        return DG

    def solve(self) -> SolverResult:
        coords, source_idx, terminal_indices, names, costs = self.parse_and_validate_input()

        # We'll keep coords as list for easier appending
        current_coords = list(coords)  # list of [lat, lng] or [lng, lat] – adjust indexing accordingly
        current_names = list(names)

        added_candidates = []
        iteration = 0

        cur_total_weight = np.inf
        cur_edges = None

        while True:
            iteration += 1
            print(f"\nIteration {iteration}")

            # Generate candidates based on current points
            voronoi_coords = self.generate_voronoi_candidates(np.array(current_coords))
            fermat_coords = self.generate_fermat_candidates(np.array(current_coords), max_candidates=100)
            candidates = np.concatenate([voronoi_coords, fermat_coords], axis=0)

            # remove duplicates
            candidates = np.unique(candidates, axis=0)

            best_cost = np.inf
            best_max_edge = 0
            best_candidate = None
            best_pruned_mst = None
            best_nodes = None
            best_edges = None


            if cur_edges is not None:
                collinear_coords = self.generate_collinear_candidates(np.array(current_coords), cur_edges, max_length=MAX_POLE_TO_POLE_LV, num_per_edge=3)
                if len(collinear_coords) > 0:
                    candidates = np.concatenate([candidates, collinear_coords], axis=0)

            for c in candidates:
                if self.is_duplicate(c, added_candidates):
                    continue

                # Build temporary point set with this candidate
                trial_coords = np.vstack([current_coords, c])
                trial_names = current_names

                trial_nodes = self._build_nodes(np.array(current_coords), [c], source_idx, terminal_indices, trial_names)
                trial_dist_matrix = self.compute_distance_matrix(trial_coords)

                pole_indices_trial = [n.index for n in trial_nodes if n.type == "pole"]

                DG = self.build_directed_graph_for_arborescence(
                    source_idx, terminal_indices, pole_indices_trial, trial_dist_matrix, costs
                )

                try:
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

                except Exception as e:
                    print(f"Candidate {c} failed: {e}")
                    continue

            # ─── Decide whether to accept ──────────────────────────────────────
            if best_cost >= cur_total_weight * 0.999:  # allow tiny worsening to escape plateaus if needed
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


        nodes = self._build_nodes(np.array(current_coords), [], source_idx, terminal_indices, current_names)

        # 6. Mark used & name poles
        used_indices = set(best_pruned_mst.nodes)
        pole_counter = 1
        used_nodes = []
        for node in nodes:
            if node.index in used_indices:
                node.used = True
                if node.type == "pole" and not node.name:
                    node.name = f"Pole {pole_counter}"
                    pole_counter += 1
                used_nodes.append(node)


        best_pruned_mst, used_nodes = self.split_long_edges_with_coords(best_pruned_mst, used_nodes)

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
