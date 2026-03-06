from .candidate_mst_solver import *
from .registry import register_solver


@register_solver
class VoronoiMSTSolver(CandidateMSTSolver):

    def __init__(self, request: OptimizationRequest):
        request.params['candidate_algorithm'] = 'voronoi'
        super().__init__(request)
