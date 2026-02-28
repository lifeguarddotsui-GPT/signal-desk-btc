import { useLocation, Link } from "wouter";
import { BarChart3, Bot, Gift, Brain, Home, Search, Package, Building2, MoreHorizontal, Activity } from "lucide-react";
import { useState } from "react";

const primaryNav = [
  { title: "Home", url: "/", icon: Home },
  { title: "Market", url: "/dashboard", icon: BarChart3 },
  { title: "Deploy", url: "/deploy", icon: Bot },
  { title: "Agents", url: "/my-agents", icon: Brain },
  { title: "More", url: "__more__", icon: MoreHorizontal },
];

const moreItems = [
  { title: "Rewards", url: "/rewards", icon: Gift },
  { title: "Protocol", url: "/protocol", icon: Building2 },
  { title: "Bundles", url: "/bundles", icon: Package },
  { title: "Debug", url: "/debug/ledger", icon: Search },
  { title: "SUI Flow", url: "/sui-flow", icon: Activity },
];

export function MobileBottomNav() {
  const [location] = useLocation();
  const [showMore, setShowMore] = useState(false);

  const isMoreActive = moreItems.some(item => location === item.url);

  return (
    <>
      {showMore && (
        <div
          className="fixed inset-0 z-40 md:hidden"
          onClick={() => setShowMore(false)}
          data-testid="overlay-more-menu"
        />
      )}

      {showMore && (
        <div className="fixed bottom-14 left-0 right-0 z-50 md:hidden px-2 pb-1" data-testid="menu-more-items">
          <div className="bg-card border rounded-md shadow-lg p-2 grid grid-cols-4 gap-1">
            {moreItems.map((item) => {
              const isActive = location === item.url;
              return (
                <Link
                  key={item.title}
                  href={item.url}
                  onClick={() => setShowMore(false)}
                  data-testid={`mobile-nav-${item.title.toLowerCase()}`}
                >
                  <div className={`flex flex-col items-center gap-0.5 py-2 px-1 rounded-md ${isActive ? "text-primary bg-primary/10" : "text-muted-foreground"}`}>
                    <item.icon className="h-4 w-4" />
                    <span className="text-[9px] font-medium">{item.title}</span>
                  </div>
                </Link>
              );
            })}
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
