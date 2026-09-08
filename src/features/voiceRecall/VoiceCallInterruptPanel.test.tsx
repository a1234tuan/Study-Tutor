import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { VoiceCallInterruptPanel } from "./VoiceCallInterruptPanel";

describe("VoiceCallInterruptPanel (§4.3 三选一)", () => {
  it("does not render when closed", () => {
    const { container } = render(
      <VoiceCallInterruptPanel open={false} onContinue={() => {}} onPauseLeave={() => {}} onEndCall={() => {}} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders the three actions when open and fires the matching callback", () => {
    const onContinue = vi.fn();
    const onPauseLeave = vi.fn();
    const onEndCall = vi.fn();
    render(
      <VoiceCallInterruptPanel open={true} onContinue={onContinue} onPauseLeave={onPauseLeave} onEndCall={onEndCall} />,
    );
    expect(screen.getByRole("dialog", { name: "通话中断确认" })).toBeDefined();
    fireEvent.click(screen.getByText("继续通话"));
    expect(onContinue).toHaveBeenCalledTimes(1);
    expect(onPauseLeave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("暂停并离开"));
    expect(onPauseLeave).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText("结束通话"));
    expect(onEndCall).toHaveBeenCalledTimes(1);
  });
});
