#!/usr/bin/env python3
"""Pure-local numerical clustering sidecar for mind synthesis.

Reads JSON on stdin:
  {"atoms":[{"id":"","statement":"","type":"","embedding":[...],"eventAt":"","conversationId":""}],"params":{}}

Writes JSON on stdout. No network calls and no file writes.
"""

from __future__ import annotations

import itertools
import json
import math
import os
import sys
import warnings
from datetime import datetime, timezone
from typing import Any

import networkx as nx
import numpy as np
from scipy.cluster.hierarchy import fcluster, linkage
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.neighbors import NearestNeighbors


DEFAULT_PARAMS = {
    "n_neighbors": 8,
    "n_components": 50,
    "min_dist": 0.0,
    "metric": "cosine",
    "random_state": 42,
    "min_cluster_size": 3,
    "min_samples": 2,
    "cluster_selection_method": "eom",
    "merge_min_similarity": 0.72,
    "merge_small_cluster_max_size": 12,
    "bridge_k": 15,
    "bridge_min_similarity": 0.5,
    "bridge_pair_similarity": 0.65,
    "bridge_limit": 20,
    "parent_target_cap": 8,
    "resurfaced_gap_days": 90,
    "resurfaced_recent_days": 30,
}


def main() -> int:
    payload = json.load(sys.stdin)
    params = normalize_params(payload.get("params") or {})
    atoms = normalize_atoms(payload.get("atoms") or [])
    result = cluster_atoms(atoms, params)
    sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":")))
    sys.stdout.write("\n")
    return 0


def normalize_params(raw: dict[str, Any]) -> dict[str, Any]:
    params = env_default_params()
    aliases = {
        "nNeighbors": "n_neighbors",
        "nComponents": "n_components",
        "minDist": "min_dist",
        "randomState": "random_state",
        "minClusterSize": "min_cluster_size",
        "minSamples": "min_samples",
        "clusterSelectionMethod": "cluster_selection_method",
        "mergeMinSimilarity": "merge_min_similarity",
        "mergeSmallClusterMaxSize": "merge_small_cluster_max_size",
        "bridgeK": "bridge_k",
        "bridgeMinSimilarity": "bridge_min_similarity",
        "bridgePairSimilarity": "bridge_pair_similarity",
        "bridgeLimit": "bridge_limit",
        "parentTargetCap": "parent_target_cap",
        "resurfacedGapDays": "resurfaced_gap_days",
        "resurfacedRecentDays": "resurfaced_recent_days",
    }
    for key, value in raw.items():
        params[aliases.get(key, key)] = value
    return params


def env_default_params() -> dict[str, Any]:
    params = dict(DEFAULT_PARAMS)
    for key, default in DEFAULT_PARAMS.items():
        env_key = f"K_MIND_CLUSTER_{key.upper()}"
        if env_key not in os.environ:
            continue
        raw = os.environ[env_key]
        if isinstance(default, int):
            params[key] = positive_int(raw, default)
        elif isinstance(default, float):
            try:
                number = float(raw)
                params[key] = number if math.isfinite(number) else default
            except (TypeError, ValueError):
                params[key] = default
        else:
            params[key] = raw
    return params


def normalize_atoms(raw_atoms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    atoms: list[dict[str, Any]] = []
    max_dim = 0
    for raw in raw_atoms:
        embedding = raw.get("embedding")
        if not isinstance(embedding, list) or len(embedding) == 0:
            continue
        vector = []
        valid = True
        for value in embedding:
            number = float(value)
            if not math.isfinite(number):
                valid = False
                break
            vector.append(number)
        if not valid:
            continue
        atom = {
            "id": str(raw.get("id") or "").strip(),
            "statement": str(raw.get("statement") or "").strip(),
            "type": str(raw.get("type") or "idea").strip() or "idea",
            "embedding": vector,
            "eventAt": str(raw.get("eventAt") or "").strip(),
            "conversationId": str(raw.get("conversationId") or "").strip(),
        }
        if not atom["id"] or not atom["statement"]:
            continue
        max_dim = max(max_dim, len(vector))
        atoms.append(atom)

    for atom in atoms:
        if len(atom["embedding"]) < max_dim:
            atom["embedding"] = atom["embedding"] + [0.0] * (max_dim - len(atom["embedding"]))
    return sorted(atoms, key=atom_sort_key)


def cluster_atoms(atoms: list[dict[str, Any]], params: dict[str, Any]) -> dict[str, Any]:
    if not atoms:
        return empty_result()

    embeddings = np.asarray([atom["embedding"] for atom in atoms], dtype=np.float64)
    labels = hdbscan_labels(embeddings, params)
    label_to_indices = labels_to_sorted_indices(labels, atoms)
    merged_label_groups = merge_near_small_cluster_labels(atoms, embeddings, label_to_indices, params)
    noise_ids = [atoms[index]["id"] for index, label in enumerate(labels) if label == -1]

    leaf_clusters, label_to_cluster_id = build_leaf_clusters(
        atoms,
        embeddings,
        merged_label_groups,
    )
    parent_themes = build_parent_themes(atoms, embeddings, leaf_clusters, params)
    resurfaced = detect_resurfaced(atoms, leaf_clusters, params)
    bridges = detect_bridges(atoms, embeddings, labels, label_to_cluster_id, params)

    return {
        "leafClusters": leaf_clusters,
        "parentThemes": parent_themes,
        "resurfaced": resurfaced,
        "newIdeaBridges": bridges,
        "noiseAtomIds": sorted(noise_ids),
    }


def empty_result() -> dict[str, Any]:
    return {
        "leafClusters": [],
        "parentThemes": [],
        "resurfaced": [],
        "newIdeaBridges": [],
        "noiseAtomIds": [],
    }


def hdbscan_labels(embeddings: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    import hdbscan

    n_atoms = embeddings.shape[0]
    min_cluster_size = positive_int(params.get("min_cluster_size"), 3)
    if n_atoms < min_cluster_size:
        return np.full(n_atoms, -1, dtype=int)

    reduced = reduce_embeddings(embeddings, params)
    clusterer = hdbscan.HDBSCAN(
        min_cluster_size=min_cluster_size,
        min_samples=positive_int(params.get("min_samples"), 2),
        cluster_selection_method=str(params.get("cluster_selection_method") or "eom"),
        prediction_data=True,
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return clusterer.fit_predict(reduced)


def reduce_embeddings(embeddings: np.ndarray, params: dict[str, Any]) -> np.ndarray:
    import umap

    n_atoms = embeddings.shape[0]
    if n_atoms <= 2:
        return embeddings

    requested_components = positive_int(params.get("n_components"), 50)
    # UMAP's spectral initialization needs fewer components than samples.
    n_components = max(2, min(requested_components, n_atoms - 2))
    n_neighbors = max(2, min(positive_int(params.get("n_neighbors"), 8), n_atoms - 1))
    reducer = umap.UMAP(
        n_neighbors=n_neighbors,
        n_components=n_components,
        min_dist=float(params.get("min_dist", 0.0)),
        metric=str(params.get("metric") or "cosine"),
        random_state=positive_int(params.get("random_state"), 42),
    )
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        return reducer.fit_transform(embeddings)


def labels_to_sorted_indices(labels: np.ndarray, atoms: list[dict[str, Any]]) -> dict[int, list[int]]:
    groups: dict[int, list[int]] = {}
    for index, label in enumerate(labels.tolist()):
        if label == -1:
            continue
        groups.setdefault(int(label), []).append(index)

    return dict(sorted(
        ((label, sorted(indices, key=lambda index: atom_sort_key(atoms[index]))) for label, indices in groups.items()),
        key=lambda entry: atom_sort_key(atoms[entry[1][0]]),
    ))


def merge_near_small_cluster_labels(
    atoms: list[dict[str, Any]],
    embeddings: np.ndarray,
    label_to_indices: dict[int, list[int]],
    params: dict[str, Any],
) -> list[dict[str, Any]]:
    if not label_to_indices:
        return []

    max_size = positive_int(params.get("merge_small_cluster_max_size"), 8)
    threshold = bounded_float(params.get("merge_min_similarity"), 0.78)
    small_entries = [
        (label, indices)
        for label, indices in label_to_indices.items()
        if len(indices) <= max_size
    ]
    large_entries = [
        (label, indices)
        for label, indices in label_to_indices.items()
        if len(indices) > max_size
    ]
    groups = [
        {"labels": [label], "indices": indices}
        for label, indices in large_entries
    ]

    if len(small_entries) <= 1 or threshold <= 0:
        groups.extend({"labels": [label], "indices": indices} for label, indices in small_entries)
        return sort_label_groups(groups, atoms)

    centroids = np.asarray([
        normalized_mean(embeddings[indices])
        for _label, indices in small_entries
    ], dtype=np.float64)
    distances = condensed_cosine_distances(centroids)
    tree = linkage(distances, method="average", optimal_ordering=True)
    merge_labels = fcluster(tree, t=max(0.0, 1.0 - threshold), criterion="distance")
    grouped: dict[int, list[int]] = {}
    for entry_index, merge_label in enumerate(merge_labels.tolist()):
        grouped.setdefault(int(merge_label), []).append(entry_index)

    for entry_indices in grouped.values():
        labels = sorted(small_entries[index][0] for index in entry_indices)
        indices = sorted(
            set(itertools.chain.from_iterable(small_entries[index][1] for index in entry_indices)),
            key=lambda index: atom_sort_key(atoms[index]),
        )
        groups.append({"labels": labels, "indices": indices})

    return sort_label_groups(groups, atoms)


def sort_label_groups(groups: list[dict[str, Any]], atoms: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        groups,
        key=lambda group: atom_sort_key(atoms[group["indices"][0]]) if group.get("indices") else ("", ""),
    )


def condensed_cosine_distances(vectors: np.ndarray) -> np.ndarray:
    normalized = normalize_rows(vectors)
    distances = []
    for left, right in itertools.combinations(range(normalized.shape[0]), 2):
        similarity = float(np.dot(normalized[left], normalized[right]))
        if not math.isfinite(similarity):
            similarity = 0.0
        similarity = min(1.0, max(-1.0, similarity))
        distances.append(max(0.0, 1.0 - similarity))
    return np.asarray(distances, dtype=np.float64)


def build_leaf_clusters(
    atoms: list[dict[str, Any]],
    embeddings: np.ndarray,
    label_groups: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[int, str]]:
    texts_by_label = {
        group_index: " ".join(atoms[index]["statement"] for index in group["indices"])
        for group_index, group in enumerate(label_groups)
    }
    keywords_by_label = keywords_for_documents(list(texts_by_label.values()), list(texts_by_label.keys()))
    clusters = []
    label_to_cluster_id = {}

    for ordinal, group in enumerate(label_groups, start=1):
        indices = group["indices"]
        cluster_id = f"cluster_{ordinal:03d}"
        for label in group["labels"]:
            label_to_cluster_id[int(label)] = cluster_id
        representative_index = representative_atom_index(indices, embeddings)
        keywords = keywords_by_label.get(ordinal - 1, [])
        clusters.append({
            "clusterId": cluster_id,
            "atomIds": [atoms[index]["id"] for index in indices],
            "representativeAtomId": atoms[representative_index]["id"],
            "label": distilled_label(keywords),
            "keywords": keywords,
            "members": cluster_members(atoms, indices),
        })

    return clusters, label_to_cluster_id


def build_parent_themes(
    atoms: list[dict[str, Any]],
    embeddings: np.ndarray,
    leaf_clusters: list[dict[str, Any]],
    params: dict[str, Any],
) -> list[dict[str, Any]]:
    if not leaf_clusters:
        return []

    atom_index_by_id = {atom["id"]: index for index, atom in enumerate(atoms)}
    leaf_indices = [
        [atom_index_by_id[atom_id] for atom_id in cluster["atomIds"] if atom_id in atom_index_by_id]
        for cluster in leaf_clusters
    ]
    centroids = np.asarray([
        normalized_mean(embeddings[indices])
        for indices in leaf_indices
    ], dtype=np.float64)

    group_labels = parent_group_labels(centroids, params)
    groups: dict[int, list[int]] = {}
    for leaf_index, group_label in enumerate(group_labels):
        groups.setdefault(int(group_label), []).append(leaf_index)

    sorted_groups = sorted(groups.values(), key=lambda leaves: leaves[0])
    texts_by_group = {}
    for ordinal, leaves in enumerate(sorted_groups, start=1):
        indices = sorted(set(itertools.chain.from_iterable(leaf_indices[leaf] for leaf in leaves)))
        texts_by_group[ordinal] = " ".join(atoms[index]["statement"] for index in indices)
    keywords_by_group = keywords_for_documents(list(texts_by_group.values()), list(texts_by_group.keys()))

    themes = []
    for ordinal, leaves in enumerate(sorted_groups, start=1):
        indices = sorted(
            set(itertools.chain.from_iterable(leaf_indices[leaf] for leaf in leaves)),
            key=lambda index: atom_sort_key(atoms[index]),
        )
        representative_index = representative_atom_index(indices, embeddings)
        keywords = keywords_by_group.get(ordinal, [])
        themes.append({
            "themeId": f"theme_{ordinal:03d}",
            "leafClusterIds": [leaf_clusters[leaf]["clusterId"] for leaf in leaves],
            "atomIds": [atoms[index]["id"] for index in indices],
            "representativeAtomId": atoms[representative_index]["id"],
            "label": distilled_label(keywords),
            "keywords": keywords,
            "members": cluster_members(atoms, indices),
        })

    return themes


def parent_group_labels(centroids: np.ndarray, params: dict[str, Any]) -> list[int]:
    n_clusters = centroids.shape[0]
    if n_clusters == 1:
        return [1]
    target = parent_target_count(n_clusters, params)
    if target >= n_clusters:
        return list(range(1, n_clusters + 1))
    tree = linkage(centroids, method="ward", optimal_ordering=True)
    return fcluster(tree, t=target, criterion="maxclust").tolist()


def parent_target_count(n_clusters: int, params: dict[str, Any]) -> int:
    if n_clusters <= 1:
        return 1
    if n_clusters < 5:
        return 1
    cap = positive_int(params.get("parent_target_cap"), 8)
    return min(cap, max(5, int(round(math.sqrt(n_clusters)))))


def keywords_for_documents(documents: list[str], keys: list[Any]) -> dict[Any, list[str]]:
    if not documents:
        return {}
    try:
        vectorizer = TfidfVectorizer(
            lowercase=True,
            stop_words="english",
            token_pattern=r"(?u)\b[a-zA-Z][a-zA-Z0-9_-]{2,}\b",
            max_features=5000,
        )
        matrix = vectorizer.fit_transform(documents)
        terms = np.asarray(vectorizer.get_feature_names_out())
    except ValueError:
        return {key: [] for key in keys}

    output: dict[Any, list[str]] = {}
    for row_index, key in enumerate(keys):
        row = matrix.getrow(row_index)
        if row.nnz == 0:
            output[key] = []
            continue
        scored = sorted(
            zip(row.indices.tolist(), row.data.tolist()),
            key=lambda item: (-item[1], terms[item[0]]),
        )
        output[key] = [str(terms[index]) for index, _score in scored[:8]]
    return output


def distilled_label(keywords: list[str]) -> str:
    cleaned = [keyword for keyword in keywords if keyword]
    if cleaned:
        return " ".join(cleaned[:5])
    return "recurring idea theme"


def cluster_members(atoms: list[dict[str, Any]], indices: list[int]) -> list[dict[str, Any]]:
    return [
        {
            "atomId": atoms[index]["id"],
            "statement": bounded_text(atoms[index]["statement"], 240),
            "type": atoms[index]["type"],
            "eventAt": atoms[index]["eventAt"],
            "conversationId": atoms[index]["conversationId"],
        }
        for index in indices
    ]


def bounded_text(value: Any, max_chars: int) -> str:
    text = " ".join(str(value or "").split())
    return text[:max_chars]


def detect_bridges(
    atoms: list[dict[str, Any]],
    embeddings: np.ndarray,
    labels: np.ndarray,
    label_to_cluster_id: dict[int, str],
    params: dict[str, Any],
) -> list[dict[str, Any]]:
    n_atoms = len(atoms)
    if n_atoms < 2 or not label_to_cluster_id:
        return []

    k = min(positive_int(params.get("bridge_k"), 15), n_atoms - 1)
    min_similarity = bounded_float(params.get("bridge_min_similarity"), 0.5)
    pair_similarity = bounded_float(params.get("bridge_pair_similarity"), 0.65)
    limit = positive_int(params.get("bridge_limit"), 20)

    neighbors = NearestNeighbors(n_neighbors=k + 1, metric="cosine")
    neighbors.fit(embeddings)
    distances, indices = neighbors.kneighbors(embeddings)
    graph = nx.Graph()
    graph.add_nodes_from(range(n_atoms))

    for source_index, row in enumerate(indices):
        for neighbor_position, target_index in enumerate(row.tolist()):
            if target_index == source_index:
                continue
            similarity = 1.0 - float(distances[source_index][neighbor_position])
            if similarity < min_similarity:
                continue
            existing = graph.get_edge_data(source_index, target_index)
            if existing and existing.get("similarity", -1.0) >= similarity:
                continue
            graph.add_edge(
                source_index,
                target_index,
                similarity=similarity,
                distance=max(1.0 - similarity, 1e-6),
            )

    if graph.number_of_edges() == 0:
        return []

    centrality = nx.betweenness_centrality(graph, normalized=True, weight="distance")
    bridges = []
    for index in sorted(range(n_atoms), key=lambda item: (-centrality.get(item, 0.0), atoms[item]["id"])):
        pair = bridge_pair_for_atom(index, graph, labels, label_to_cluster_id, pair_similarity)
        if not pair:
            continue
        bridges.append({
            "atomId": atoms[index]["id"],
            "connectsClusterIds": list(pair),
            "betweenness": round(float(centrality.get(index, 0.0)), 12),
        })
        if len(bridges) >= limit:
            break
    return bridges


def bridge_pair_for_atom(
    index: int,
    graph: nx.Graph,
    labels: np.ndarray,
    label_to_cluster_id: dict[int, str],
    pair_similarity: float,
) -> tuple[str, str] | None:
    pairs: set[tuple[str, str]] = set()
    node_cluster = cluster_id_for_label(labels[index], label_to_cluster_id)
    neighbor_clusters = set()

    for neighbor in graph.neighbors(index):
        similarity = float(graph[index][neighbor].get("similarity", 0.0))
        if similarity < pair_similarity:
            continue
        other_cluster = cluster_id_for_label(labels[neighbor], label_to_cluster_id)
        if not other_cluster:
            continue
        neighbor_clusters.add(other_cluster)
        if node_cluster and other_cluster != node_cluster:
            pairs.add(tuple(sorted((node_cluster, other_cluster))))

    if not node_cluster:
        for left, right in itertools.combinations(sorted(neighbor_clusters), 2):
            pairs.add((left, right))

    return sorted(pairs)[0] if pairs else None


def cluster_id_for_label(label: int | np.integer, label_to_cluster_id: dict[int, str]) -> str | None:
    return label_to_cluster_id.get(int(label))


def detect_resurfaced(
    atoms: list[dict[str, Any]],
    leaf_clusters: list[dict[str, Any]],
    params: dict[str, Any],
) -> list[dict[str, Any]]:
    now = parse_datetime(params.get("now")) or datetime.now(timezone.utc)
    gap_days = positive_int(params.get("resurfaced_gap_days"), 90)
    recent_days = positive_int(params.get("resurfaced_recent_days"), 30)
    atom_by_id = {atom["id"]: atom for atom in atoms}
    outputs = []

    for cluster in leaf_clusters:
        dated = sorted(
            (
                (parse_datetime(atom_by_id[atom_id].get("eventAt")), atom_by_id[atom_id])
                for atom_id in cluster["atomIds"]
                if atom_id in atom_by_id
            ),
            key=lambda item: (item[0] or datetime.min.replace(tzinfo=timezone.utc), atom_sort_key(item[1])),
        )
        dated = [(date, atom) for date, atom in dated if date is not None and date <= now]
        if len(dated) < 2:
            continue
        month_bins = monthly_bins(dated)
        if not month_bins:
            continue
        detected = resurfaced_gap(dated, now, gap_days, recent_days)
        if not detected:
            continue
        previous_date, resurfaced_date, observed_gap_days = detected
        outputs.append({
            "clusterId": cluster["clusterId"],
            "previousActiveAt": isoformat(previous_date),
            "resurfacedAt": isoformat(resurfaced_date),
            "gapDays": int(math.floor(observed_gap_days)),
        })

    return outputs


def monthly_bins(dated: list[tuple[datetime, dict[str, Any]]]) -> dict[str, int]:
    bins: dict[str, int] = {}
    for date, _atom in dated:
        key = date.strftime("%Y-%m")
        bins[key] = bins.get(key, 0) + 1
    return bins


def resurfaced_gap(
    dated: list[tuple[datetime, dict[str, Any]]],
    now: datetime,
    gap_days: int,
    recent_days: int,
) -> tuple[datetime, datetime, float] | None:
    recent_cutoff = now.timestamp() - (recent_days * 86_400)
    for index in range(1, len(dated)):
        previous_date = dated[index - 1][0]
        current_date = dated[index][0]
        observed_gap_days = (current_date.timestamp() - previous_date.timestamp()) / 86_400
        current_is_recent = current_date.timestamp() >= recent_cutoff
        if observed_gap_days > gap_days and current_is_recent:
            return previous_date, current_date, observed_gap_days
    return None


def representative_atom_index(indices: list[int], embeddings: np.ndarray) -> int:
    if len(indices) == 1:
        return indices[0]
    vectors = embeddings[indices]
    centroid = normalized_mean(vectors)
    normalized_vectors = normalize_rows(vectors)
    scores = normalized_vectors @ centroid
    best_position = sorted(
        range(len(indices)),
        key=lambda position: (-float(scores[position]), indices[position]),
    )[0]
    return indices[best_position]


def normalized_mean(vectors: np.ndarray) -> np.ndarray:
    if vectors.size == 0:
        return np.asarray([], dtype=np.float64)
    mean = np.mean(vectors, axis=0)
    norm = np.linalg.norm(mean)
    if norm == 0:
        return mean
    return mean / norm


def normalize_rows(vectors: np.ndarray) -> np.ndarray:
    norms = np.linalg.norm(vectors, axis=1)
    safe_norms = np.where(norms == 0, 1.0, norms)
    return vectors / safe_norms[:, None]


def parse_datetime(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        text = str(value).strip()
        if text.endswith("Z"):
            text = f"{text[:-1]}+00:00"
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def isoformat(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def atom_sort_key(atom: dict[str, Any]) -> tuple[str, str]:
    return (str(atom.get("eventAt") or ""), str(atom.get("id") or ""))


def positive_int(value: Any, fallback: int) -> int:
    try:
        number = int(float(value))
        return number if number > 0 else fallback
    except (TypeError, ValueError):
        return fallback


def bounded_float(value: Any, fallback: float) -> float:
    try:
        number = float(value)
        if math.isfinite(number):
            return min(1.0, max(0.0, number))
    except (TypeError, ValueError):
        pass
    return fallback


if __name__ == "__main__":
    raise SystemExit(main())
