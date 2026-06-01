import {
  ArrowRight,
  ImageIcon,
  Sparkles,
} from "lucide-react";
import productPreviewUrl from "../../../docs/assets/app-preview.png";
import { useI18n } from "./i18n";

interface HomePageProps {
  onOpenCanvas: () => void;
  onOpenGallery: () => void;
}

export function HomePage({
  onOpenCanvas,
  onOpenGallery,
}: HomePageProps) {
  const { t } = useI18n();

  return (
    <main className="home-page app-view" data-testid="home-page">
      <section className="home-hero" aria-labelledby="home-title">
        <div className="home-hero__visual" aria-hidden="true">
          <img className="home-preview-image" src={productPreviewUrl} alt="" />
        </div>

        <div className="home-hero__copy">
          <p className="home-kicker">
            <Sparkles className="size-4" aria-hidden="true" />
            {t("homeKicker")}
          </p>
          <h1 id="home-title">{t("homeTitle")}</h1>
          <p className="home-deck">{t("homeDeck")}</p>

          <div className="home-actions" aria-label={t("homeEntryAria")}>
            <button
              className="home-action home-action--primary"
              data-testid="home-open-canvas"
              type="button"
              onClick={onOpenCanvas}
            >
              <Sparkles className="size-4" aria-hidden="true" />
              {t("navCanvas")}
            </button>
          </div>

        </div>
      </section>

      <section className="home-afterfold" aria-label={t("homeAfterfoldAria")}>
        <button className="home-gallery-link" data-testid="home-gallery-link" type="button" onClick={onOpenGallery}>
          <ImageIcon className="size-4" aria-hidden="true" />
          {t("homeGallery")}
          <ArrowRight className="size-4" aria-hidden="true" />
        </button>
      </section>
    </main>
  );
}
