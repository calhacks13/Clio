import json

from clio_pipeline.schema import transfer_warnings, validate_episode


def _lines(path):
    return path.read_text().splitlines()


def _replace_line(path, lineno, text):
    lines = _lines(path)
    lines[lineno - 1] = text
    path.write_text("\n".join(lines) + "\n")


def _edit_json_line(path, lineno, edit):
    record = json.loads(_lines(path)[lineno - 1])
    edit(record)
    _replace_line(path, lineno, json.dumps(record))


def test_valid_episode_has_no_issues(episode_dir):
    assert validate_episode(episode_dir) == []


def test_plan_with_step_actions_is_valid(planned_episode_dir):
    # meta.plan references #/$defs/Check, so this also exercises $ref resolution.
    assert validate_episode(planned_episode_dir) == []


def test_corrupted_frame_line_is_reported_with_file_and_line_number(episode_dir):
    frames = episode_dir / "frames.ndjson"
    _edit_json_line(frames, 5, lambda r: r["left"].update(joints=r["left"]["joints"][:199]))

    issues = validate_episode(episode_dir)

    assert len(issues) == 1
    issue = issues[0]
    assert (issue.file, issue.line) == ("frames.ndjson", 5)
    assert issue.path == "$.left.joints"
    assert str(issue).startswith("frames.ndjson:5: $.left.joints: ")
    assert "200" in issue.message and "199" in issue.message
    assert len(str(issue)) < 300  # the 199 numbers are not dumped into the message


def test_non_number_inside_joints_is_pinpointed(episode_dir):
    frames = episode_dir / "frames.ndjson"
    _edit_json_line(frames, 7, lambda r: r["right"]["joints"].__setitem__(3, "0.5"))
    _edit_json_line(frames, 8, lambda r: r["left"]["joints"].__setitem__(12, True))

    issues = validate_episode(episode_dir)

    assert [(i.line, i.path, i.message) for i in issues] == [
        (7, "$.right.joints[3]", "'0.5' is not of type 'number'"),
        (8, "$.left.joints[12]", "True is not of type 'number'"),
    ]


def test_invalid_json_line_is_reported(episode_dir):
    _replace_line(episode_dir / "events.ndjson", 3, '{"t": 50, "type": ')

    [issue] = validate_episode(episode_dir)

    assert (issue.file, issue.line) == ("events.ndjson", 3)
    assert "invalid JSON" in issue.message


def test_non_finite_number_is_rejected(episode_dir):
    frames = episode_dir / "frames.ndjson"
    _replace_line(frames, 2, _lines(frames)[1].replace('"head":[', '"head":[NaN,', 1))

    [issue] = validate_episode(episode_dir)

    assert (issue.file, issue.line) == ("frames.ndjson", 2)
    assert "NaN" in issue.message


def test_unknown_event_type_is_named(episode_dir):
    _edit_json_line(episode_dir / "events.ndjson", 4, lambda r: r.update(type="step.teleported"))

    [issue] = validate_episode(episode_dir)

    assert (issue.file, issue.line) == ("events.ndjson", 4)
    assert issue.message.startswith("unknown type 'step.teleported'; expected one of: ")
    assert "step.entered" in issue.message


def test_event_error_names_the_missing_field_of_its_type(episode_dir):
    # Line 4 is the first step.entered; without the discriminator the error would only say
    # "is not valid under any of the given schemas".
    _edit_json_line(episode_dir / "events.ndjson", 4, lambda r: r.pop("instruction"))

    [issue] = validate_episode(episode_dir)

    assert (issue.file, issue.line, issue.path) == ("events.ndjson", 4, "$")
    assert "'instruction' is a required property" in issue.message


def test_meta_issue_has_a_path_but_no_line(episode_dir):
    meta = json.loads((episode_dir / "meta.json").read_text())
    meta["mode"] = "teleport"
    (episode_dir / "meta.json").write_text(json.dumps(meta))

    [issue] = validate_episode(episode_dir)

    assert (issue.file, issue.line, issue.path) == ("meta.json", None, "$.mode")
    assert str(issue).startswith("meta.json: $.mode: ")


def test_unknown_check_type_inside_the_plan_is_named(default_episode, plan):
    plan["steps"][1]["success"] = {"type": "teleport"}
    default_episode.meta["plan"] = plan
    episode = default_episode.write()

    [issue] = validate_episode(episode)

    assert (issue.file, issue.path) == ("meta.json", "$.plan.steps[1].success")
    assert issue.message.startswith("unknown type 'teleport'; expected one of: pinch_near")


def test_check_error_comes_from_the_branch_its_type_selects(default_episode, plan):
    # A pinch_near check with a bad hand: the error must be about `hand`, not about `type` not
    # matching one of the other eight check types.
    plan["steps"][1]["success"]["hand"] = "third"
    default_episode.meta["plan"] = plan
    episode = default_episode.write()

    [issue] = validate_episode(episode)

    assert (issue.file, issue.path) == ("meta.json", "$.plan.steps[1].success.hand")
    assert "'third' is not one of" in issue.message


def test_optional_files_may_be_missing(episode_dir):
    (episode_dir / "objects.ndjson").unlink()
    (episode_dir / "finish.json").unlink()

    assert validate_episode(episode_dir) == []


def test_required_file_missing_is_reported(episode_dir):
    (episode_dir / "frames.ndjson").unlink()

    [issue] = validate_episode(episode_dir)

    assert (issue.file, issue.line) == ("frames.ndjson", None)
    assert "missing" in issue.message


def test_time_going_backwards_is_reported(episode_dir):
    frames = episode_dir / "frames.ndjson"
    lines = _lines(frames)
    lines[9], lines[10] = lines[10], lines[9]  # lines 10 and 11 swap
    frames.write_text("\n".join(lines) + "\n")

    [issue] = validate_episode(episode_dir)

    assert (issue.file, issue.line, issue.path) == ("frames.ndjson", 11, "$.t")
    assert "before the previous line" in issue.message


def test_hand_layout_other_than_webxr_order_is_reported(episode_dir):
    meta = json.loads((episode_dir / "meta.json").read_text())
    meta["hands"]["joints"] = list(reversed(meta["hands"]["joints"]))
    (episode_dir / "meta.json").write_text(json.dumps(meta))

    [issue] = validate_episode(episode_dir)

    assert (issue.file, issue.path) == ("meta.json", "$.hands.joints")


def test_issues_per_file_are_capped_with_a_summary(episode_dir):
    frames = episode_dir / "frames.ndjson"
    for lineno in range(1, 31):
        _edit_json_line(frames, lineno, lambda r: r.pop("head"))

    issues = validate_episode(episode_dir, max_issues_per_file=5)

    assert [i.line for i in issues[:5]] == [1, 2, 3, 4, 5]
    assert len(issues) == 6
    assert "30 invalid lines" in issues[5].message


# --- transfer integrity (batches.json is server bookkeeping, not part of the schemas) -------------


def _write_batches(episode_dir, received, gaps):
    (episode_dir / "batches.json").write_text(json.dumps({"received": received, "gaps": gaps}))


def test_no_transfer_warnings_when_every_batch_arrived(episode_dir):
    _write_batches(episode_dir, [0, 1, 2], [])  # finish.json says 3 batches were sent

    assert transfer_warnings(episode_dir) == []


def test_episode_without_server_bookkeeping_has_no_transfer_warnings(episode_dir):
    assert transfer_warnings(episode_dir) == []


def test_lost_batches_are_warned_about(episode_dir):
    _write_batches(episode_dir, [0, 2], [1])

    warnings = transfer_warnings(episode_dir)

    assert [str(w) for w in warnings] == [
        "batches.json: batch seq 1 never arrived",
        "batches.json: finish.json says 3 batches were sent, the server received 2",
    ]
