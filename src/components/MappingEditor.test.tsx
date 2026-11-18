// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import modelJson from "../../samples/contentful-model.json";
import goldenJson from "../../samples/golden/mapping-article.json";
import { Mapping } from "@/core/mapping";
import { contentType, parseModel } from "@/core/model";

vi.mock("@/app/actions", () => ({ saveMappingAction: vi.fn(async () => ({ status: "ok", message: "Saved." })) }));
const { MappingEditor } = await import("./MappingEditor");

const article = contentType(parseModel(modelJson), "article");
const golden = Mapping.parse(goldenJson);

describe("MappingEditor", () => {
  it("shows a problem as soon as a required field is emptied, and enables saving", async () => {
    const user = userEvent.setup();
    render(<MappingEditor contentType={article} initial={golden} />);
    expect(screen.getByRole("button", { name: "No changes" })).toBeDisabled();
    expect(screen.getByText("0 errors · 0 warnings")).toBeInTheDocument();

    const author = screen.getByRole("group", { name: /Author/ });
    await user.selectOptions(within(author).getByLabelText("Fill from"), "none");

    expect(within(author).getByText("Author is required but not mapped")).toBeInTheDocument();
    expect(screen.getByText("1 errors · 0 warnings")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled();
  });

  it("offers only transforms that can fill the field", () => {
    render(<MappingEditor contentType={article} initial={golden} />);
    const date = within(screen.getByRole("group", { name: /Published at/ })).getByLabelText("Fill from");
    const enabled = within(date)
      .getAllByRole("option")
      .filter((o) => !(o as HTMLOptionElement).disabled)
      .map((o) => o.textContent);
    expect(enabled).toEqual(["utcDate", "none"]);
  });

  it("lets a reviewer choose sources with checkboxes", async () => {
    const user = userEvent.setup();
    render(<MappingEditor contentType={article} initial={golden} />);
    const topics = screen.getByRole("group", { name: /Topics/ });
    const tags = within(topics).getByRole("checkbox", { name: "tags" });
    expect(tags).toBeChecked();
    await user.click(tags);
    expect(tags).not.toBeChecked();
  });
});
