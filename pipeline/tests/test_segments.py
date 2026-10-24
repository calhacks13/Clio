from clio_pipeline.episode import load_episode
from clio_pipeline.segments import Mistake, Segment, frame_labels, mistakes, step_segments

TITLE = "Fold a T-shirt in two seconds"


def _tiny(new_episode, procedure="default"):
    """10 frames, t = 0, 100, ..., 900. A runs [100, 400) and is completed by its check; B is
    entered at 400 and never completed, so it ends when C is entered at 700; C never completes
    and runs to the last frame."""
    kwargs = {} if procedure == "default" else {"procedure": procedure}
    b = new_episode(**kwargs)
    for k in range(10):
        b.frame(k * 100.0)
    b.step_entered(100.0, "a", 0, "Do A.")
    b.step_completed(400.0, "a", 0, by="check", duration_ms=300.0)
    b.step_entered(400.0, "b", 1, "Do B.", ["cup"])
    b.step_entered(700.0, "c", 2, "Do C.")
    return load_episode(b.write())


def test_segments_end_at_completion_next_entry_or_last_frame(new_episode):
    segments = step_segments(_tiny(new_episode))

    assert segments == [
        Segment("a", 0, "Do A.", 100.0, 400.0, completed_by="check", forced=False),
        Segment("b", 1, "Do B.", 400.0, 700.0, completed_by=None, forced=False, targets=("cup",)),
        Segment("c", 2, "Do C.", 700.0, 900.0, completed_by=None, forced=False),
    ]
    assert [s.duration_ms for s in segments] == [300.0, 300.0, 200.0]


def test_frame_labels_follow_the_active_step(new_episode):
    labels = frame_labels(_tiny(new_episode))

    assert labels.step_index.tolist() == [-1, 0, 0, 0, 1, 1, 1, 2, 2, 2]
    assert labels.segment.tolist() == [-1, 0, 0, 0, 1, 1, 1, 2, 2, 2]
    assert list(labels.task) == [TITLE] + ["Do A."] * 3 + ["Do B."] * 3 + ["Do C."] * 3


def test_frames_after_the_last_completed_step_are_outside_any_step(new_episode):
    b = new_episode(procedure=None)
    for k in range(6):
        b.frame(k * 100.0)
    b.step_entered(0.0, "a", 0, "Do A.")
    b.step_completed(300.0, "a", 0, by="coach", forced=True, duration_ms=300.0)
    ep = load_episode(b.write())

    [segment] = step_segments(ep)
    labels = frame_labels(ep)

    assert (segment.completed_by, segment.forced) == ("coach", True)
    assert labels.step_index.tolist() == [0, 0, 0, -1, -1, -1]
    assert list(labels.task) == ["Do A."] * 3 + [""] * 3  # no procedure: no title to fall back on


def test_completion_of_a_step_that_is_not_active_is_ignored(new_episode):
    b = new_episode()
    for k in range(4):
        b.frame(k * 100.0)
    b.step_entered(0.0, "a", 0, "Do A.")
    b.step_completed(100.0, "zzz", 5)
    b.step_completed(200.0, "a", 0, by="user")

    [segment] = step_segments(load_episode(b.write()))

    assert (segment.step_id, segment.end_t, segment.completed_by) == ("a", 200.0, "user")


def test_default_episode_segments_and_label_counts(episode_dir):
    ep = load_episode(episode_dir)

    segments = step_segments(ep)
    labels = frame_labels(ep, segments)

    assert [(s.step_id, s.start_t, s.end_t, s.completed_by) for s in segments] == [
        ("lay-flat", 100.0, 1000.0, "coach"),
        ("pinch-shoulder", 1000.0, 2000.0, "check"),
        ("pinch-middle", 2000.0, 2983.333, None),
    ]
    # t_k = k * 1000/60: frames 0-5 precede the first step; t_6 = 100, t_60 = 1000, t_120 = 2000
    steps = labels.step_index.tolist()
    assert steps == [-1] * 6 + [0] * 54 + [1] * 60 + [2] * 60
    assert labels.task[0] == TITLE
    assert labels.task[60] == "With your left hand, pinch the shirt at the shoulder dot."


def test_segments_expose_the_plan_step_action_verb(planned_episode_dir):
    ep = load_episode(planned_episode_dir)

    segments = step_segments(ep)
    labels = frame_labels(ep, segments)

    assert [s.action_verb for s in segments] == ["other", "pinch", None]
    assert segments[1].action == {"verb": "pinch", "object": "shoulder", "hand": "left"}
    assert (labels.action_verb[0], labels.action_verb[70], labels.action_verb[150]) == (
        "",
        "pinch",
        "",
    )


def test_without_a_plan_there_are_no_action_verbs(episode_dir):
    ep = load_episode(episode_dir)

    assert [s.action_verb for s in step_segments(ep)] == [None, None, None]
    assert set(frame_labels(ep).action_verb) == {""}


def test_mistakes_are_listed_with_their_step(episode_dir):
    assert mistakes(load_episode(episode_dir)) == [
        Mistake(
            t=1500.0,
            step_id="pinch-shoulder",
            kind="wrong_hand",
            message="Use your left hand for the shoulder dot.",
            source="rule",
        ),
    ]


def test_procedure_aborted_closes_the_open_step(new_episode):
    # 8 frames, t = 0, 100, ..., 700. A runs [100, 300) and is completed; B is entered at 300 and
    # still open when the procedure is aborted at 500, so B ends there and frames 500-700 are
    # outside any step.
    b = new_episode()
    for k in range(8):
        b.frame(k * 100.0)
    b.step_entered(100.0, "a", 0, "Do A.")
    b.step_completed(300.0, "a", 0, by="check", duration_ms=200.0)
    b.step_entered(300.0, "b", 1, "Do B.")
    b.event(500.0, "procedure.aborted", reason="user quit")
    ep = load_episode(b.write())

    segments = step_segments(ep)
    labels = frame_labels(ep, segments)

    assert [(s.step_id, s.start_t, s.end_t, s.completed_by) for s in segments] == [
        ("a", 100.0, 300.0, "check"),
        ("b", 300.0, 500.0, None),
    ]
    assert labels.step_index.tolist() == [-1, 0, 0, 1, 1, -1, -1, -1]
    assert list(labels.task) == [TITLE, "Do A.", "Do A.", "Do B.", "Do B.", TITLE, TITLE, TITLE]


def test_procedure_completed_closes_the_open_step(new_episode):
    b = new_episode(procedure=None)
    for k in range(5):
        b.frame(k * 100.0)
    b.step_entered(0.0, "a", 0, "Do A.")
    b.event(200.0, "procedure.completed", durationMs=200.0)
    ep = load_episode(b.write())

    [segment] = step_segments(ep)
    labels = frame_labels(ep, [segment])

    assert (segment.end_t, segment.completed_by) == (200.0, None)
    assert labels.step_index.tolist() == [0, 0, -1, -1, -1]
    assert list(labels.task) == ["Do A.", "Do A.", "", "", ""]
