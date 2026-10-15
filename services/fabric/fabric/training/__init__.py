"""Remote training: a job contract, resumable checkpoints, an acceptance gate and candidates.

Local work (validation, configs, the NumPy fixture, the run record, the release
manifest) runs on any machine. The GPU step runs wherever the user chooses, and
the contract is the same there. See docs/21-remote-training.md for what has and
has not been verified.
"""
