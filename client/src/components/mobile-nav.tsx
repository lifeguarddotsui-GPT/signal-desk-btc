import { useLocation, Link } from "wouter";
import {
  BarChart3, Bot, Gift, Brain, Home, Search, Package, Building2,
  MoreHorizontal, Activity, Map, Trophy, GraduationCap, FileText,
  BookOpen, User, X,
} from "lucide-react";
import { useState } from "react";

const primaryNav = [
  { title: "Home", url: "/", icon: Home },
  { title: "Market", url: "/dashboard", icon: BarChart3 },
  { title: "Deploy", url: "/deploy", icon: Bot },
  { title: "Agents", url: "/my-agents", icon: Brain },
  { title: "More", url: "__more__", icon: MoreHorizontal },
];

const moreCategories = [
  {
    label: "Trading",
    items: [
      { title: "Rewards", url: "/rewards", icon: Gift },
      { title: "Bundles", url: "/bundles", icon: Package },
      { title: "Leaderboard", url: "/leaderboard", icon: Trophy },
    ],
  },
  {
    label: "Intelligence",
    items: [
      { title: "Learning", url: "/learn", icon: GraduationCap },
      { title: "Guide", url: "/guide", icon: Map },
    ],
  },
  {
    label: "Tools",
    items: [
      { title: "SUI Flow", url: "/sui-flow", icon: Activity },
      { title: "Debug", url: "/debug/ledger", icon: Search },
    ],
  },
  {
    label: "Account",
    items: [
      { title: "Profile", url: "/profile", icon: User },
      { title: "Protocol", url: "/protocol", icon: Building2 },
      { title: "Docs", url: "/docs", icon: FileText },
      { title: "Setup", url: "/instructions", icon: BookOpen },
    ],
  },
];

const allMoreUrls = moreCategories.flatMap(c => c.items.map(i => i.url));

export function MobileBottomNav() {
  const [location] = useLocation();
  const [showMore, setShowMore] = useState(false);

  const isMoreActive = allMoreUrls.includes(location);

  return (
    <>
      {showMore && (
        <div
          className="fixed inset-0 z-40 bg-black/30 md:hidden"
          onClick={() => setShowMore(false)}
          data-testid="overlay-more-menu"
        />
      )}

      {showMore && (
        <div className="fixed bottom-14 left-0 right-0 z-50 md:hidden px-2 pb-1" data-testid="menu-more-items">
          <div className="bg-card border rounded-lg shadow-lg p-2.5 space-y-2 max-h-[60vh] overflow-y-auto">
            <div className="flex items-center justify-between px-1">
              <span className="text-[10px] font-semibold text-foreground">All Pages</span>
              <button
                onClick={() => setShowMore(false)}
                className="text-muted-foreground hover:text-foreground p-0.5"
                data-testid="button-close-more"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            {moreCategories.map((category, idx) => (
              <div key={category.label}>
                {idx > 0 && <div className="border-t border-border/30 my-1.5" />}
                <p className="text-[8px] uppercase tracking-wider text-muted-foreground font-medium px-1 mb-1">
                  {category.label}
                </p>
                <div className="grid grid-cols-4 gap-1">
                  {category.items.map((item) => {
                    const isActive = location === item.url;
                    return (
                      <Link
                        key={item.title}
                        href={item.url}
                        onClick={() => setShowMore(false)}
                        data-testid={`mobile-nav-${item.title.toLowerCase().replace(/\s+/g, "-")}`}
                      >
                        <div className={`flex flex-col items-center gap-0.5 py-2 px-1 rounded-md transition-colors ${isActive ? "text-primary bg-primary/10" : "text-muted-foreground hover:bg-muted/50"}`}>
                          <item.icon className="h-4 w-4" />
                          <span className="text-[9px] font-medium">{item.title}</span>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <nav className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-background border-t" data-testid="nav-mobile-bottom">
        <div className="flex items-center justify-around py-1.5 px-1">
          {primaryNav.map((item) => {
            if (item.url === "__more__") {
              return (
                <button
                  key="more"
                  onClick={() => setShowMore(!showMore)}
                  className={`flex flex-col items-center gap-0.5 py-1 px-2 min-w-0 ${isMoreActive || showMore ? "text-primary" : "text-muted-foreground"}`}
                  data-testid="mobile-nav-more"
                >
                  <MoreHorizontal className="h-5 w-5" />
                  <span className="text-[9px] font-medium">More</span>
                </button>
              );
            }

            const isActive = location === item.url;
            return (
              <Link key={item.title} href={item.url} data-testid={`mobile-nav-${item.title.toLowerCase()}`}>
                <div className={`flex flex-col items-center gap-0.5 py-1 px-2 min-w-0 ${isActive ? "text-primary" : "text-muted-foreground"}`}>
                  <item.icon className="h-5 w-5" />
                  <span className="text-[9px] font-medium">{item.title}</span>
                </div>
              </Link>
            );
          })}
        </div>
      </nav>
    </>
  );
}
