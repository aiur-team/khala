"""Read only by default; guarded sends never activate a session or broadcast."""
import json
import re
import sys


async def operate(connection, uuid, text=None, expected=None):
    import iterm2

    app = await iterm2.async_get_app(connection)
    session = app.get_session_by_id(uuid)
    if session is None:
        return {"reason": "iterm2_session_missing"}
    screen = await session.async_get_screen_contents()
    cursor = screen.cursor_coord
    # ScreenContents uses absolute buffer coordinates, including lost history.
    row = cursor.y - screen.windowed_coord_range.coord_range.start.y
    if row < 0 or row >= screen.number_of_lines:
        return {"reason": "iterm2_cursor_unavailable"}
    contents = screen.line(row)
    styled = ""
    for column in range(session.grid_size.width):
        try:
            character = contents.string_at(column)
        except IndexError:
            break
        style = contents.style_at(column)
        styled += ("\x1b[2m" if style and style.faint else "\x1b[22m") + character
    if re.sub(r"\x1b\[[0-9;]*m", "", styled) != contents.string:
        return {"reason": "iterm2_style_unavailable"}
    view = {"tty": await session.async_get_variable("tty"),
            "cursorX": cursor.x, "cursorY": cursor.y,
            "line": styled}
    if text is None:
        return view
    # The TypeScript prompt guard approved this exact snapshot. A full literal
    # pattern avoids translating JavaScript regex syntax or trusting a draft.
    if (expected is None or view["tty"] != expected["tty"]
            or view["cursorX"] != expected["cursorX"]
            or view["cursorY"] != expected["cursorY"]
            or re.fullmatch(re.escape(expected["line"]), view["line"]) is None):
        return {"status": "not_empty"}
    await session.async_send_text(text, suppress_broadcast=True)
    return {"status": "sent"}


if __name__ == "__main__":
    import iterm2

    async def main(connection):
        expected = json.loads(sys.argv[3]) if len(sys.argv) > 3 else None
        result = await operate(connection, sys.argv[1],
                               sys.argv[2] if len(sys.argv) > 2 else None, expected)
        print(json.dumps(result))

    iterm2.run_until_complete(main)
