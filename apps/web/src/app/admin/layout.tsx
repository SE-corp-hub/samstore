import TextSizeBoot from "../../components/admin/TextSizeBoot";
import { TEXT_SIZE_BOOT_SCRIPT } from "../../lib/text-size";

/**
 * Every /admin page (login, dashboard, courier) gets the text size saved on this tablet
 * (Large = 18 px unless the owner picked another) before the first paint, so the page never
 * flashes small text. The storefront is not under /admin and keeps its own sizes.
 */
export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <script dangerouslySetInnerHTML={{ __html: TEXT_SIZE_BOOT_SCRIPT }} />
      <TextSizeBoot />
      {children}
    </>
  );
}
