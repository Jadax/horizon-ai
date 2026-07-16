-- ═══════════════════════════════════════════════════════════════════════
-- MIGRATION — expands target_sources (topic harvesting) and
-- footage_keywords (stock footage variety) per niche. Safe to re-run;
-- uses UPDATE so it refreshes existing rows rather than skipping them.
--
-- NOTE ON SCOPE: footage sourcing stays on Pexels + Pixabay only — these
-- are the only stock-video providers with public APIs licensed for this
-- kind of automated use. Sites like Coverr/Mixkit/Videezy don't expose
-- APIs for bulk automated fetching, and scraping them would carry the
-- same ToS risk we specifically designed around for gameplay footage.
-- What's expanded here is the *breadth* of search terms and topic
-- sources within that same safe footprint.
-- ═══════════════════════════════════════════════════════════════════════

update niche_configurations set
  target_sources = array[
    'r/gamingsuggestions','r/Eldenring','r/fromsoftware','r/gaming',
    'r/darksouls3','r/bloodborne','r/Fallout','r/skyrim','r/masseffect',
    'r/zelda','r/GamingLeaksAndRumours'
  ],
  footage_keywords = array[
    'dark fantasy landscape','gothic castle','medieval ruins','fog forest cinematic',
    'armor knight','ancient stone architecture','torch fire dark hallway',
    'stormy castle ruins','wasteland desert cinematic','abandoned bunker interior',
    'snowy mountain fortress','cathedral interior dramatic light'
  ]
where niche_name = 'Gaming/Lore';

update niche_configurations set
  target_sources = array[
    'r/oddlysatisfying','r/CozyPlaces','r/EarthPorn','r/SkyPorn',
    'r/WaterPorn','r/slowtv','r/NatureIsFuckingLit','r/ExposurePorn'
  ],
  footage_keywords = array[
    'cinematic landscape drone','ocean waves slow motion','misty mountains',
    'city rain window','clouds timelapse','forest sunlight rays',
    'lake reflection calm','autumn leaves falling','desert dunes aerial',
    'waterfall slow motion','snow falling forest','golden hour field'
  ]
where niche_name = 'Aesthetic';

update niche_configurations set
  target_sources = array[
    'r/psychology','r/DecidingToBeBetter','r/getdisciplined','r/Stoicism',
    'r/selfimprovement','r/socialskills','r/philosophy'
  ],
  footage_keywords = array[
    'person thinking silhouette','brain abstract','rain window contemplative',
    'walking alone city night','minimal abstract shapes','empty room natural light',
    'clock time lapse','crowd blurred motion','solitary figure horizon',
    'candle flame close up','journal writing hands','city lights night bokeh'
  ]
where niche_name = 'Psychology';

update niche_configurations set
  target_sources = array[
    'r/travel','r/solotravel','r/backpacking','r/digitalnomad',
    'r/travelhacks','r/shoestring','r/onebag'
  ],
  footage_keywords = array[
    'tropical beach drone','old town europe street','night market asia',
    'safari sunset','mountain road aerial','train window countryside',
    'airport terminal walking','street food vendor','rooftop city skyline',
    'boat ocean island','hiking trail viewpoint','local market colorful stalls'
  ]
where niche_name = 'Travel';
