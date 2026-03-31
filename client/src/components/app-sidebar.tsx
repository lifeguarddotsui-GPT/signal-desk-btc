import { BarChart3, Bot, Gift, Activity, BookOpen, User, Home, Brain, Trophy, Building2, FileText, Search, Package, GraduationCap, Map, Code, Waves, Telescope } from "lucide-react";
import { useLocation, Link } from "wouter";
import logoPath from "@/assets/images/logo.png";
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";

const navItems = [
  { title: "Home", url: "/", icon: Home },
  { title: "Market Dashboard", url: "/dashboard", icon: BarChart3 },
  { title: "Market Intelligence", url: "/market-intel", icon: Telescope },
  { title: "Deploy Agent", url: "/deploy", icon: Bot },
  { title: "My Agents", url: "/my-agents", icon: Brain },
  { title: "Claim Rewards", url: "/rewards", icon: Gift },
  { title: "Leaderboard", url: "/leaderboard", icon: Trophy },
  { title: "Protocol", url: "/protocol", icon: Building2 },
  { title: "Docs", url: "/docs", icon: FileText },
  { title: "Learning Engine", url: "/learn", icon: GraduationCap },
  { title: "System Guide", url: "/guide", icon: Map },
  { title: "Instructions", url: "/instructions", icon: BookOpen },
  { title: "Profile", url: "/profile", icon: User },
  { title: "Execution Bundles", url: "/bundles", icon: Package },
  { title: "Debug Ledger", url: "/debug/ledger", icon: Search },
  { title: "SUI Flow", url: "/sui-flow", icon: Activity },
  { title: "Open Code", url: "/open-code", icon: Code },
  { title: "About", url: "/about", icon: Waves },
];

export function AppSidebar() {
  const [location] = useLocation();

  return (
    <Sidebar>
      <SidebarHeader className="p-4 pb-2">
        <Link href="/">
          <div className="flex flex-col items-center gap-2 cursor-pointer" data-testid="link-home">
            <img src={logoPath} alt="Blue Water Agents" className="w-16 h-16 rounded-lg object-cover" />
            <div className="text-center">
              <h1 className="text-sm font-bold tracking-tight text-sidebar-foreground">
                Blue Water Agents
              </h1>
            </div>
          </div>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel className="text-[10px] uppercase tracking-widest text-muted-foreground">
            Navigation
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => {
                const isActive = location === item.url;
                return (
                  <SidebarMenuItem key={item.title}>
                    <SidebarMenuButton
                      asChild
                      isActive={isActive}
                      data-testid={`nav-${item.title.toLowerCase().replace(/\s+/g, "-")}`}
                    >
                      <Link href={item.url}>
                        <item.icon className="h-4 w-4" />
                        <span className="text-sm">{item.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter className="p-4 space-y-1">
        <div className="text-[10px] font-mono text-muted-foreground text-center">
          Powered by Blue Water Protocol LLC
        </div>
        <div className="text-[10px] font-mono text-muted-foreground text-center">
          Developed by lifeguard.sui
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
