# C4G Renewvia Mini-Grid Optimization Backend

## Purpose

Provide a REST API for the C4G Renewvia Mini-Grid Optimization.

## File Structure

- server.py: Main file for the backend.
  - /optimize: API endpoint for the optimization. Calls mst.py.
- mst.py: Implementation of the MST algorithm.
  - Generates Candidate Points for Power Poles
  - Optimizes the Power Pole and Line layout
  - Cleans up the Power Pole and Line results
  - returns the results
