# C4G Renewvia Mini-Grid Optimization Backend

## Purpose

Provide a REST API for the C4G Renewvia Mini-Grid Optimization.

## File Structure

- server.py: Main file for the backend.
  - /optimize: API endpoint for the optimization. Calls mst.py.
- mst.py: Implementation of the MST algorithm.
  - Calls candidate_generation.py: Generates Candidate Points for Power Poles
    - Currenlty there are 2 candidate generation methods:
      - Voronoi: Generates points based on voronoi diagram
      - Fermat: Generates points based on Fermat's Little Theorem
  - Calls build_graph: build gragh from all coordinates and clean up optimized graph
  - Optimizes the Power Pole and Line layout
  - Cleans up the Power Pole and Line results
  - returns the results
- utils.py
  - parse input
  - haversine distance calculations
  - bounding box calculations

TODO:

- Integrate Voltage Drop Calculations
- Restrict to low voltage for now
- Convert csv export to KLM file
- Explore more/alternative optimal solutions
- Generate restriction masks for water
- Make framework expandable for High Voltage and multiple power sources in the future
