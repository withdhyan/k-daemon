import numpy as np

from cluster import DEFAULT_PARAMS, build_leaf_clusters, merge_near_small_cluster_labels


def test_centroid_merge_collapses_related_smoking_and_cancer_leaves():
    atoms = [
        atom("cancer-a", "Cancer concern needs a concrete health review thread.", "2026-06-20"),
        atom("cancer-b", "Cancer screening anxiety needs a practical follow-up.", "2026-06-21"),
        atom("cancer-c", "Cancer risk should become one review plan.", "2026-06-22"),
        atom("smoking-a", "Smoking is the adjacent risk factor to resolve.", "2026-06-23"),
        atom("smoking-b", "Smoking risk belongs beside the cancer concern.", "2026-06-24"),
        atom("smoking-c", "Smoking cessation should connect to the cancer concern.", "2026-06-25"),
    ]
    embeddings = np.asarray([
        [1.00, 0.00, 0.00],
        [0.99, 0.01, 0.00],
        [0.98, 0.02, 0.00],
        [0.75, 0.66, 0.00],
        [0.74, 0.67, 0.00],
        [0.76, 0.65, 0.00],
    ], dtype=np.float64)
    hdbscan_split_labels = {0: [0, 1, 2], 1: [3, 4, 5]}

    strict_groups = merge_near_small_cluster_labels(
        atoms,
        embeddings,
        hdbscan_split_labels,
        {**DEFAULT_PARAMS, "merge_min_similarity": 0.78},
    )
    assert len(strict_groups) == 2

    merged_groups = merge_near_small_cluster_labels(
        atoms,
        embeddings,
        hdbscan_split_labels,
        DEFAULT_PARAMS,
    )
    leaf_clusters, label_to_cluster_id = build_leaf_clusters(atoms, embeddings, merged_groups)

    assert len(merged_groups) == 1
    assert merged_groups[0]["labels"] == [0, 1]
    assert len(leaf_clusters) == 1
    assert leaf_clusters[0]["clusterId"] == "cluster_001"
    assert leaf_clusters[0]["atomIds"] == [
        "idea_cancer-a",
        "idea_cancer-b",
        "idea_cancer-c",
        "idea_smoking-a",
        "idea_smoking-b",
        "idea_smoking-c",
    ]
    assert label_to_cluster_id == {0: "cluster_001", 1: "cluster_001"}


def atom(identifier, statement, event_date):
    return {
        "id": f"idea_{identifier}",
        "statement": statement,
        "type": "idea",
        "embedding": [],
        "eventAt": f"{event_date}T00:00:00.000Z",
        "conversationId": f"conversation-{identifier}",
    }
